import {test, expect} from '@playwright/test';

test.beforeEach(async ({request}) => {
  const response = await request.post('/__fixture/reset');
  expect(response.ok()).toBeTruthy();
});

const fixtureState = async (request) => (await (await request.get('/__fixture/state')).json()).data;

async function redeem(page) {
  await page.goto('/redeem');
  await page.getByLabel('卡号', {exact: true}).fill('MANGO-DEMO');
  await page.getByLabel('密钥', {exact: true}).fill('preview-only');
  await page.getByRole('button', {name: '查看可用资源', exact: true}).click();
  await expect(page.getByRole('button', {name: '签发下载授权', exact: true})).toBeVisible();
}

test('catalog search, display modes and persisted themes work without page errors', async ({page}, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.resource-card')).toHaveCount(6);
  await page.getByRole('button', {name: '浅色主题', exact: true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', 'light');
  await page.screenshot({path: info.outputPath('home-desktop-light.png'), fullPage: true});
  await page.getByRole('searchbox', {name: '搜索资源'}).fill('Termux');
  await expect(page.locator('.resource-card')).toHaveCount(2);
  await page.getByRole('button', {name: '列表视图', exact: true}).click();
  await expect(page.locator('.resource-grid')).toHaveClass(/list-view/);
  await page.getByRole('searchbox', {name: '搜索资源'}).fill('no-match-fixture');
  await expect(page.getByRole('heading', {name: '没有找到匹配的资源'})).toBeVisible();
  await page.getByRole('button', {name: '查看全部资源', exact: true}).click();
  await expect(page.locator('.resource-card')).toHaveCount(6);
  await page.getByRole('button', {name: '网格视图', exact: true}).click();
  await page.getByRole('button', {name: '深色主题', exact: true}).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', 'dark');
  await expect(page.locator('.resource-card')).toHaveCount(6);
  await page.screenshot({path: info.outputPath('home-desktop-dark.png'), fullPage: true});
  expect(errors).toEqual([]);
});

test('mobile pages have no horizontal overflow and usable navigation', async ({page}, info) => {
  await page.setViewportSize({width: 390, height: 844});
  for (const route of [
    '/',
    '/resources/frpc-arm64',
    '/redeem',
    '/item/101',
    '/user/index/query',
    '/user/authentication/login',
    '/help',
  ]) {
    await page.goto(route);
    await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBeTruthy();
  }
  await page.goto('/');
  await expect(page.locator('.resource-card')).toHaveCount(6);
  await page.getByRole('button', {name: '浅色主题', exact: true}).click();
  await page.screenshot({path: info.outputPath('home-mobile-light.png'), fullPage: true});
  await page.getByRole('button', {name: '展开导航', exact: true}).click();
  await page
    .getByRole('navigation', {name: '主要导航'})
    .getByRole('link', {name: '卡密兑换', exact: true})
    .click();
  await expect(page).toHaveURL(/\/redeem$/);
  await expect(page.getByRole('navigation', {name: '主要导航'})).toBeHidden();
});

test('busy labels and rich descriptions remain inert and accessible', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {button, setBusy, renderRichText} = await import('/ui/dev/dom.js');
    const target = button('提交');
    setBusy(target, true, '处理中');
    setBusy(target, false, '提交');
    const content = renderRichText(
      '<p onclick="window.__unsafe=1">安全 <b>文本</b></p><script>window.__unsafe=1</script><svg onload="window.__unsafe=1"></svg><a href="javascript:alert(1)" style="color:red">危险链接</a><img src="javascript:alert(1)" onerror="window.__unsafe=1"><iframe srcdoc="unsafe"></iframe>'
    );
    return {
      label: target.textContent,
      disabled: target.disabled,
      text: content.textContent,
      scripts: content.querySelectorAll('script,svg,iframe,img,[onclick],[onerror],[style],a[href]').length,
      unsafe: window.__unsafe === 1,
    };
  });
  expect(result).toEqual({
    label: '提交',
    disabled: false,
    text: '安全 文本危险链接',
    scripts: 0,
    unsafe: false,
  });
});

test('redemption is explicit, retries recover one grant, and failed card checks retain it', async ({
  page,
  request,
}) => {
  await redeem(page);
  expect((await fixtureState(request)).grantCount).toBe(0);
  await page.getByRole('button', {name: '签发下载授权', exact: true}).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeVisible();
  expect((await fixtureState(request)).grantCount).toBe(1);
  await page.getByRole('button', {name: '核验并恢复链接', exact: true}).click();
  await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeVisible();
  expect((await fixtureState(request)).grantCount).toBe(1);
  await page.getByLabel('密钥', {exact: true}).fill('wrong');
  await page.getByRole('button', {name: '查看可用资源', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('已有资源与恢复凭证仍保留');
  await expect(page.getByRole('button', {name: '核验并恢复链接', exact: true})).toBeEnabled();
  expect(page.url()).not.toContain('MANGO-DEMO');
  expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain('card');
});

test('a pending grant keeps its recovery credential even if the card form is submitted again', async ({
  page,
  request,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let checks = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/redeem') checks++;
  });
  await page.route('**/api/grants', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({response});
  });
  try {
    await redeem(page);
    await page.getByRole('button', {name: '签发下载授权', exact: true}).click();
    await expect.poll(async () => (await fixtureState(request)).grantCount).toBe(1);
    await expect(page.getByRole('button', {name: '查看可用资源', exact: true})).toBeDisabled();
    await page
      .locator('#redeem-form')
      .evaluate((form) => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(checks).toBe(1);
    release();
    await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '核验并恢复链接', exact: true})).toBeEnabled();
  } finally {
    release();
  }
});

test('revalidating a card temporarily prevents issuing credentials from the previous result', async ({
  page,
}) => {
  await redeem(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/redeem', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({response});
  });
  try {
    await page.getByRole('button', {name: '查看可用资源', exact: true}).click();
    await expect(page.getByRole('button', {name: '签发下载授权', exact: true})).toBeDisabled();
  } finally {
    release();
  }
});

test('a lost grant response is retried with the identical credential, including zero quota', async ({
  page,
  request,
}) => {
  const credentials = [];
  await page.route('**/api/grants', async (route) => {
    credentials.push(new URLSearchParams(route.request().postData()).get('credential'));
    const response = await route.fetch();
    if (credentials.length === 1) await route.abort('failed');
    else await route.fulfill({response, json: {...(await response.json()), quota: 0}});
  });
  await redeem(page);
  await page.getByRole('button', {name: '签发下载授权', exact: true}).click();
  await expect(page.locator('.grant-status')).toContainText('恢复按钮');
  await page.getByRole('button', {name: '核验并恢复链接', exact: true}).click();
  await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeVisible();
  await expect(page.locator('.quota-summary')).toContainText('剩余 0 次');
  await page.getByRole('button', {name: '核验并恢复链接', exact: true}).click();
  await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeVisible();
  expect(credentials).toHaveLength(3);
  expect(new Set(credentials).size).toBe(1);
  expect((await fixtureState(request)).grantCount).toBe(1);
});

test('expired grants disable links and clipboard failure offers a manual copy field', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('blocked');
        },
      },
    });
  });
  await page.route('**/api/grants', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {...(await response.json()), expires_at: new Date(Date.now() + 1800).toISOString()},
    });
  });
  await redeem(page);
  await page.getByRole('button', {name: '签发下载授权', exact: true}).click();
  await page.getByRole('button', {name: '复制链接', exact: true}).click();
  await expect(page.locator('.manual-copy')).toBeVisible();
  await expect(page.locator('.manual-copy')).toHaveValue(/\/p\/fixture\//);
  await expect(page.locator('.grant-status')).toContainText('下载授权已过期');
  await expect(page.getByRole('button', {name: '复制链接', exact: true})).toBeDisabled();
  await expect(page.getByRole('link', {name: '打开下载链接', exact: true})).toBeHidden();
  await expect(page.locator('.manual-copy')).toHaveCount(0);
});

test('legacy GET links prefill confirmation, scrub secrets, and never consume grants', async ({
  page,
  request,
}) => {
  let mutations = 0;
  page.on('request', (req) => {
    if (/\/api\/(redeem|grants)$/.test(req.url())) mutations += 1;
  });
  await page.goto('/dl/private/tool.zip?card=MANGO-DEMO&key=preview-only');
  await expect(page).toHaveURL(/\/redeem$/);
  await expect(page.getByLabel('卡号', {exact: true})).toHaveValue('MANGO-DEMO');
  await expect(page.getByLabel('密钥', {exact: true})).toHaveValue('preview-only');
  expect(mutations).toBe(0);
  expect((await fixtureState(request)).grantCount).toBe(0);
  await page.goto('/dl/private/tool.zip?token=bad');
  await expect(page.getByRole('alert')).toContainText('凭证格式无效');
  expect(mutations).toBe(0);
});

test('valid referral IDs reach the bootstrap visitor', async ({page}) => {
  const bootstraps = [];
  page.on('request', (req) => {
    if (req.url().includes('/user/api/storefront/bootstrap')) bootstraps.push(req.url());
  });
  await page.goto('/?from=123');
  await expect(page.locator('.resource-card')).toHaveCount(6);
  expect(bootstraps.some((url) => new URL(url).searchParams.get('from') === '123')).toBeTruthy();
});

test('all customer routes set meaningful page titles', async ({page}) => {
  await page.goto('/item/101');
  await expect(page.getByRole('heading', {name: '开发者工具包', exact: true})).toBeVisible();
  await expect(page).toHaveTitle('开发者工具包 · MangoQWQ 资源站');
  await page.goto('/user/index/query');
  await expect(page).toHaveTitle('订单查询 · MangoQWQ 资源站');
});
