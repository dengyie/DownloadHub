import {test, expect} from '@playwright/test';

test.beforeEach(async ({request}) => {
  await request.post('/__fixture/reset');
});

test('login, account overview and logout share the existing session', async ({page}) => {
  await page.goto('/user/authentication/login');
  await page.getByLabel('用户名 / 邮箱 / 手机', {exact: true}).fill('mango');
  await page.getByLabel('密码', {exact: true}).fill('preview-only');
  await page.getByLabel('图片验证码', {exact: true}).fill('4286');
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
  await expect(page.getByText('¥68.00', {exact: true})).toBeVisible();
  await page.getByRole('link', {name: '退出登录', exact: true}).click();
  await expect(page.getByRole('button', {name: '登录', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/\/user\/authentication\/login$/);
});

for (const channel of ['email', 'phone']) {
  test(`${channel} registration can submit after its send-code image is consumed`, async ({page}) => {
    await page.route('**/user/api/storefront/bootstrap*', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.data.auth.registration_type = channel === 'email' ? 2 : 1;
      data.data.auth[`${channel}_verification`] = true;
      await route.fulfill({response, json: data});
    });
    await page.goto('/user/authentication/register');
    await page.getByLabel('用户名', {exact: true}).fill('mangotest');
    await page
      .getByLabel(channel === 'email' ? '邮箱地址' : '手机号码', {exact: true})
      .fill(channel === 'email' ? 'preview@example.test' : '13800138000');
    await page.getByLabel('发送前的图片验证码', {exact: true}).fill('4286');
    await page.getByRole('button', {name: '发送验证码', exact: true}).click();
    await expect(page.getByText('验证码已发送', {exact: true})).toBeVisible();
    await page.getByLabel(channel === 'email' ? '邮箱验证码' : '短信验证码', {exact: true}).fill('123456');
    await page.getByLabel('密码', {exact: true}).fill('preview-only');
    await page.getByLabel('确认密码', {exact: true}).fill('preview-only');
    await page.getByLabel('图片验证码', {exact: true}).fill('4286');
    expect(await page.locator('#auth-form').evaluate((form) => form.checkValidity())).toBeTruthy();
    await page.getByRole('button', {name: '创建账户', exact: true}).click();
    await expect(page.getByRole('heading', {name: '你好，mango'})).toBeVisible();
  });
}

test('password recovery submits the received code, not the image captcha', async ({page}) => {
  let fields;
  page.on('request', (req) => {
    if (req.url().endsWith('/user/api/authentication/password')) fields = new URLSearchParams(req.postData());
  });
  await page.goto('/user/authentication/emailForget');
  await page.getByLabel('邮箱地址', {exact: true}).fill('preview@example.test');
  await page.getByLabel('发送前的图片验证码', {exact: true}).fill('4286');
  await page.getByRole('button', {name: '发送验证码', exact: true}).click();
  await expect(page.getByText('验证码已发送', {exact: true})).toBeVisible();
  await page.getByLabel('邮箱验证码', {exact: true}).fill('123456');
  await page.getByLabel('设置新密码', {exact: true}).fill('preview-only');
  await page.getByLabel('确认密码', {exact: true}).fill('preview-only');
  await page.getByRole('button', {name: '重置密码', exact: true}).click();
  await expect(page.getByText('密码已重置，请使用新密码重新登录。', {exact: true})).toBeVisible();
  expect(fields.get('captcha')).toBe('123456');
  expect(fields.get('username')).toBe('preview@example.test');
  expect(page.url()).not.toContain('preview@example');
});

test('unavailable authentication settings fail closed and can be retried', async ({page}) => {
  let unavailable = true;
  await page.route('**/user/api/storefront/bootstrap*', async (route) => {
    if (unavailable) await route.fulfill({status: 503, json: {code: 503, msg: '暂不可用'}});
    else await route.continue();
  });
  await page.goto('/user/authentication/login');
  await expect(page.getByRole('heading', {name: '暂时无法加载', exact: true})).toBeVisible();
  await expect(page.getByLabel('密码', {exact: true})).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', {name: '重新加载', exact: true}).click();
  await expect(page.getByRole('button', {name: '登录', exact: true})).toBeVisible();
});
