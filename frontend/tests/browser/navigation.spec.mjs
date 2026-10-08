import {test, expect} from '@playwright/test';

test.beforeEach(async ({request}) => {
  await request.post('/__fixture/reset');
});

test('leaving a still-loading catalog cancels its pending search navigation', async ({page}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/user/api/index/commodity?*', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({response}).catch(() => {});
  });
  try {
    await page.goto('/');
    await page.getByRole('searchbox', {name: '搜索资源'}).fill('route-guard');
    await page
      .getByRole('navigation', {name: '主要导航'})
      .getByRole('link', {name: '使用帮助', exact: true})
      .click();
    await expect(page).toHaveURL(/\/help$/);
    // Cross the catalog's 250ms debounce window while its first load is pending.
    await page.waitForTimeout(450);
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', {level: 1})).toHaveText('让每一次下载，都顺利一点。');
  } finally {
    release();
  }
});

test('login return paths outside the SPA perform a real document navigation', async ({page}) => {
  let documentRequests = 0;
  await page.route('**/user/bill/index', async (route) => {
    if (route.request().isNavigationRequest()) documentRequests++;
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>Existing account center</title><h1>收支账单</h1>',
    });
  });
  await page.goto('/user/authentication/login?goto=%2Fuser%2Fbill%2Findex');
  await page.getByLabel('用户名 / 邮箱 / 手机', {exact: true}).fill('mango');
  await page.getByLabel('密码', {exact: true}).fill('preview-only');
  await page.getByLabel('图片验证码', {exact: true}).fill('4286');
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('heading', {name: '收支账单', exact: true})).toBeVisible();
  expect(documentRequests).toBe(1);
});

test('document routes accept a single trailing slash consistently', async ({page}) => {
  for (const [path, title] of [
    ['/redeem/', '卡密兑换'],
    ['/item/101/', '开发者工具包'],
    ['/user/index/query/', '订单查询'],
    ['/user/authentication/login/', '欢迎回来'],
  ]) {
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(title));
    await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible();
  }
});

test('invalid referral values are never forwarded to the visitor API', async ({page}) => {
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/user/api/storefront/bootstrap')) requests.push(request.url());
  });
  await page.goto('/?from=123%26unrelated%3Dvalue');
  await expect(page.locator('.resource-card')).toHaveCount(6);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => !new URL(url).searchParams.has('from'))).toBeTruthy();
});

test('legacy document aliases keep the correct navigation item active', async ({page}) => {
  for (const [path, active] of [
    ['/orders', '订单查询'],
    ['/cat/11', '资源广场'],
    ['/user/index/index', '资源广场'],
    ['/item/101', '资源广场'],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole('navigation', {name: '主要导航'}).getByRole('link', {name: active, exact: true})
    ).toHaveAttribute('aria-current', 'page');
  }
});

test('mobile navigation restores its accessible toggle name after navigating', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await page.getByRole('button', {name: '展开导航', exact: true}).click();
  await page
    .getByRole('navigation', {name: '主要导航'})
    .getByRole('link', {name: '使用帮助', exact: true})
    .click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole('button', {name: '展开导航', exact: true})).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});
