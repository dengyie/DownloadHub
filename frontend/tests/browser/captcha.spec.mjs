import {test, expect} from '@playwright/test';
import {captchaPNG} from '../captcha-fixture.mjs';

test.beforeEach(async ({request}) => {
  await request.post('/__fixture/reset');
});

async function credentials(page) {
  await page.getByLabel('用户名 / 邮箱 / 手机', {exact: true}).fill('mango');
  await page.getByLabel('密码', {exact: true}).fill('preview-only');
  await page.getByLabel('图片验证码', {exact: true}).fill('4286');
}

test('login submits the ID paired with the displayed PNG, without a session cookie', async ({page}) => {
  let expectedID;
  await page.route('**/user/captcha/image?**', async (route) => {
    const response = await route.fetch();
    expectedID = response.headers()['x-captcha-id'];
    await route.fulfill({response});
  });
  await page.goto('/user/authentication/login');
  await credentials(page);
  const submitted = page.waitForRequest('**/user/api/authentication/login');
  await page.getByRole('button', {name: '登录', exact: true}).click();
  const fields = new URLSearchParams((await submitted).postData());
  expect(expectedID).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(fields.get('captcha_id')).toBe(expectedID);
  expect(fields.get('captcha_code')).toBe('4286');
  expect(fields.has('captcha')).toBe(false);
  await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
});

test('refresh responses cannot replace a newer image/ID pair even if transport ignores abort', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.captchaResponses = [];
    window.fetch = async (url, options) => {
      if (!String(url).includes('/user/captcha/image')) return original(url, options);
      const response = await original(url, {...options, signal: undefined});
      return new Promise((resolve) =>
        window.captchaResponses.push({
          id: response.headers.get('X-Captcha-Id'),
          deliver: () => resolve(response),
        })
      );
    };
  });
  await page.goto('/user/authentication/login');
  await expect.poll(() => page.evaluate(() => window.captchaResponses.length)).toBe(1);
  await page.getByRole('button', {name: '更换图片验证码', exact: true}).click();
  await expect.poll(() => page.evaluate(() => window.captchaResponses.length)).toBe(2);
  const latest = await page.evaluate(() => {
    window.captchaResponses[1].deliver();
    return window.captchaResponses[1].id;
  });
  await expect(page.getByLabel('图片验证码', {exact: true})).toBeEnabled();
  const source = await page.locator('.captcha-refresh img').getAttribute('src');
  await page.evaluate(() => window.captchaResponses[0].deliver());
  await credentials(page);
  expect(await page.locator('.captcha-refresh img').getAttribute('src')).toBe(source);
  const submitted = page.waitForRequest('**/user/api/authentication/login');
  await page.getByRole('button', {name: '登录', exact: true}).click();
  expect(new URLSearchParams((await submitted).postData()).get('captcha_id')).toBe(latest);
  await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
});

for (const failure of ['missing-id', 'invalid-png', 'network']) {
  test(`captcha ${failure} blocks submission and a manual retry recovers`, async ({page}) => {
    let fail = true;
    await page.route('**/user/captcha/image?**', async (route) => {
      if (!fail) return route.continue();
      if (failure === 'network') return route.abort();
      return route.fulfill({
        contentType: 'image/png',
        headers: failure === 'missing-id' ? {} : {'X-Captcha-Id': 'a'.repeat(22)},
        body: failure === 'invalid-png' ? Buffer.from('broken png') : captchaPNG,
      });
    });
    await page.goto('/user/authentication/login');
    await expect(page.getByText('验证码加载失败，请点击图片重试。', {exact: true})).toBeVisible();
    await expect(page.getByLabel('图片验证码', {exact: true})).toBeDisabled();
    await page.getByLabel('用户名 / 邮箱 / 手机', {exact: true}).fill('mango');
    await page.getByLabel('密码', {exact: true}).fill('preview-only');
    let posts = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/authentication/login')) posts++;
    });
    await page.getByRole('button', {name: '登录', exact: true}).click();
    expect(posts).toBe(0);
    fail = false;
    await page.getByRole('button', {name: '更换图片验证码', exact: true}).click();
    await credentials(page);
    await page.getByRole('button', {name: '登录', exact: true}).click();
    await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
  });
}

test('refresh and page exit release every captcha object URL', async ({page}) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    window.captchaURLs = {created: [], revoked: []};
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.captchaURLs.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.captchaURLs.revoked.push(url);
      revoke(url);
    };
  });
  await page.goto('/user/authentication/login');
  for (let i = 1; i <= 3; i++) {
    await expect.poll(() => page.evaluate(() => window.captchaURLs.created.length)).toBe(i);
    await expect(page.getByLabel('图片验证码', {exact: true})).toBeEnabled();
    if (i < 3) await page.getByRole('button', {name: '更换图片验证码', exact: true}).click();
  }
  await page.getByRole('link', {name: '返回资源广场', exact: true}).click();
  const urls = await page.evaluate(() => window.captchaURLs);
  expect(new Set(urls.revoked)).toEqual(new Set(urls.created));
});

test('an expired image cannot submit and can be explicitly refreshed', async ({page}) => {
  await page.clock.install();
  await page.goto('/user/authentication/login');
  await credentials(page);
  await page.clock.fastForward(300001);
  await expect(page.getByText('验证码已过期，请点击图片更换。', {exact: true})).toBeVisible();
  await expect(page.getByLabel('图片验证码', {exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '更换图片验证码', exact: true}).click();
  await expect(page.getByLabel('图片验证码', {exact: true})).toBeEnabled();
});

test('two tabs can submit their original images independently', async ({page, context}) => {
  const second = await context.newPage();
  await page.goto('/user/authentication/login');
  await credentials(page);
  await second.goto('/user/authentication/login');
  await credentials(second);
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
  await second.getByRole('button', {name: '登录', exact: true}).click();
  await expect(second.getByRole('heading', {name: '你好，mango'})).toBeVisible();
});

test('a stuck image request times out instead of leaving an unusable loading form', async ({page}) => {
  await page.clock.install();
  await page.route('**/user/captcha/image?**', () => {});
  await page.goto('/user/authentication/login');
  await expect(page.getByText('验证码加载中…', {exact: true})).toBeVisible();
  await page.clock.fastForward(10001);
  await expect(page.getByText('验证码加载失败，请点击图片重试。', {exact: true})).toBeVisible();
  await expect(page.getByLabel('图片验证码', {exact: true})).toBeDisabled();
});

test('a stalled image decode times out, releases its URL and cannot overwrite a retry', async ({page}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    const revoke = URL.revokeObjectURL.bind(URL);
    window.revokedCaptchaURLs = [];
    URL.revokeObjectURL = (url) => {
      window.revokedCaptchaURLs.push(url);
      revoke(url);
    };
    HTMLImageElement.prototype.decode = function () {
      if (!this.closest('.captcha-refresh') || window.releaseCaptchaDecode) return decode.call(this);
      return new Promise((resolve) => {
        window.releaseCaptchaDecode = resolve;
      });
    };
  });
  await page.goto('/user/authentication/login');
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseCaptchaDecode))).toBe(true);
  const pendingURL = await page.locator('.captcha-refresh img').getAttribute('src');
  await page.clock.fastForward(10001);
  await expect(page.getByText('验证码加载失败，请点击图片重试。', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.revokedCaptchaURLs)).toContain(pendingURL);
  await expect(page.getByLabel('图片验证码', {exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '更换图片验证码', exact: true}).click();
  await credentials(page);
  const currentURL = await page.locator('.captcha-refresh img').getAttribute('src');
  await page.evaluate(() => window.releaseCaptchaDecode());
  expect(await page.locator('.captcha-refresh img').getAttribute('src')).toBe(currentURL);
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
});
