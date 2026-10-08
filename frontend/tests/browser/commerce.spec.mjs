import {test, expect} from '@playwright/test';

test.beforeEach(async ({page, request}) => {
  await request.post('/__fixture/reset');
  await page.addInitScript(() => {
    window.__policyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      window.__policyViolations.push(event.violatedDirective)
    );
  });
});

const state = async (request) => (await (await request.get('/__fixture/state')).json()).data;

async function fillCustomer(page) {
  await page.getByLabel('邮箱地址', {exact: true}).fill('preview@example.test');
  await page.getByLabel('查询密码', {exact: true}).fill('preview-only');
  await page.getByLabel('图形验证码', {exact: true}).fill('4286');
}

test('checkout preserves SKU fields, submits once, and retrieves password-protected content', async ({
  page,
  request,
}, info) => {
  const trades = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => {
    if (req.url().endsWith('/user/api/order/trade')) trades.push(new URLSearchParams(req.postData()));
  });
  await page.goto('/item/101');
  await page.getByRole('button', {name: '完整套装 · ¥24.00', exact: true}).click();
  await page.getByRole('button', {name: 'Windows', exact: true}).click();
  await page.getByLabel('购买数量', {exact: true}).fill('2');
  await fillCustomer(page);
  await expect(page.getByRole('button', {name: '创建订单并支付 ¥48.00', exact: true})).toBeEnabled();
  await page.getByLabel('优惠券（选填）', {exact: true}).fill('FREE');
  const submit = page.getByRole('button', {name: '创建免费订单', exact: true});
  await expect(submit).toBeEnabled();
  await page.screenshot({path: info.outputPath('product-desktop.png'), fullPage: true});
  await submit.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.getByRole('heading', {name: '订单已创建', exact: true})).toBeVisible();
  expect(trades).toHaveLength(1);
  expect(Object.fromEntries(trades[0])).toMatchObject({
    item_id: '101',
    race: '完整套装',
    'sku[平台]': 'Windows',
    num: '2',
    coupon: 'FREE',
    contact: 'preview@example.test',
    password: 'preview-only',
    captcha: '4286',
  });
  expect((await state(request)).tradeCount).toBe(1);
  await page.getByRole('link', {name: '查看订单', exact: true}).click();
  await expect(page.getByRole('heading', {name: '查询结果（1）'})).toBeVisible();
  await expect(page.locator('.order-secret')).toHaveCount(0);
  await page.getByLabel('查询密码', {exact: true}).fill('incorrect');
  await page.getByRole('button', {name: '验证并查看', exact: true}).click();
  await expect(page.getByText('查询密码错误', {exact: true})).toBeVisible();
  await expect(page.locator('.order-secret')).toHaveCount(0);
  await page.getByLabel('查询密码', {exact: true}).fill('preview-only');
  await page.getByRole('button', {name: '验证并查看', exact: true}).click();
  await expect(page.locator('.order-secret')).toHaveText('MANGO-DEMO / preview-only');
  expect(page.url()).not.toMatch(/preview|password|contact/);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => window.__policyViolations)).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({path: info.outputPath('order-desktop.png'), fullPage: true});
});

test('unpaid checkout exposes only a safe cashier link, not premature delivery content', async ({page}) => {
  await page.route('**/user/api/order/trade', (route) =>
    route.fulfill({
      json: {
        code: 200,
        data: {
          tradeNo: '202610090000000001',
          amount: '12.00',
          secret: 'MUST-NOT-DISCLOSE',
          url: '/user/pay/order?id=fixture',
        },
      },
    })
  );
  await page.goto('/item/101');
  await expect(page.locator('.product-form')).toBeVisible();
  await page.locator('.product-form').evaluate((form) => {
    window.__checkoutEvents = [];
    for (const type of ['change', 'mousedown', 'mouseup', 'click', 'submit', 'invalid']) {
      form.addEventListener(
        type,
        (event) => window.__checkoutEvents.push({type, tag: event.target.tagName, id: event.target.id}),
        true
      );
    }
  });
  await fillCustomer(page);
  await page.getByRole('button', {name: '创建订单并支付 ¥12.00', exact: true}).click();
  const events = await page.evaluate(() => window.__checkoutEvents);
  expect(
    events.some((event) => event.type === 'submit'),
    JSON.stringify(events)
  ).toBeTruthy();
  await expect(page.getByRole('link', {name: '继续支付', exact: true})).toHaveAttribute(
    'href',
    /\/user\/pay\/order\?id=fixture$/
  );
  await expect(page.getByText('MUST-NOT-DISCLOSE')).toHaveCount(0);
  await expect(page.locator('.product-form button[type=submit]')).toBeDisabled();
});

test('lost trade responses never automatically create a second order', async ({page, request}) => {
  await page.route('**/user/api/order/trade', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.goto('/item/101');
  await fillCustomer(page);
  await page.getByRole('button', {name: '创建订单并支付 ¥12.00', exact: true}).click();
  await expect(
    page.getByText('没有收到明确的下单结果。请先用订单号或联系方式查询，确认后再决定是否重新下单。', {
      exact: true,
    })
  ).toBeVisible();
  await expect(page.locator('.product-form button[type=submit]')).toBeDisabled();
  await page
    .locator('.product-form')
    .evaluate((form) => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect((await state(request)).tradeCount).toBe(1);
  await expect(page.getByRole('button', {name: '已核对订单，重新准备下单', exact: true})).toBeVisible();
});

test('late prices for an old race cannot overwrite the currently selected quote', async ({page}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/user/api/index/valuation', async (route) => {
    const response = await route.fetch();
    if (new URLSearchParams(route.request().postData()).get('race') === '标准版') await gate;
    await route.fulfill({response}).catch(() => {});
  });
  try {
    const oldQuote = page.waitForRequest((req) => req.url().endsWith('/user/api/index/valuation'));
    await page.goto('/item/101');
    await oldQuote;
    await page.getByRole('button', {name: '完整套装 · ¥24.00', exact: true}).click();
    await expect(page.locator('.product-form .price')).toHaveText('¥24.00');
    release();
    await fillCustomer(page);
    await expect(page.getByRole('button', {name: '创建订单并支付 ¥24.00', exact: true})).toBeEnabled();
  } finally {
    release();
  }
});

test('custom fields and selected cards use the existing top-level PHP form contract', async ({
  page,
}, info) => {
  let trade;
  page.on('request', (req) => {
    if (req.url().endsWith('/user/api/order/trade')) trade = new URLSearchParams(req.postData());
  });
  await page.route('**/user/api/index/commodityDetail?*', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    Object.assign(data.data, {
      draft_status: 1,
      draft_premium: 1,
      widget: JSON.stringify([
        {name: 'user_note', cn: '用途说明', type: 'textarea', required: true},
        {name: 'extras', cn: '附加选项', type: 'checkbox', dict: '示例=sample,文档=docs', required: true},
      ]),
    });
    await route.fulfill({response, json: data});
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/item/101');
  await page.getByRole('button', {name: '选择卡片', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '选择卡片', exact: true});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: '选择此卡', exact: true}).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel('购买数量', {exact: true}).fill('2');
  await expect(page.getByText('购买数量已更改，自选卡已取消，将随机发货。', {exact: true})).toBeVisible();
  await page.getByLabel('购买数量', {exact: true}).fill('1');
  await page.getByRole('button', {name: '选择卡片', exact: true}).click();
  await dialog.getByRole('button', {name: '选择此卡', exact: true}).click();
  await fillCustomer(page);
  await page.getByLabel('用途说明（必填）', {exact: true}).fill('Local browser regression');
  await page.getByLabel('示例', {exact: true}).check();
  await page.getByLabel('文档', {exact: true}).check();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBeTruthy();
  await page.screenshot({path: info.outputPath('product-mobile.png'), fullPage: true});
  await page.getByRole('button', {name: '创建订单并支付 ¥12.00', exact: true}).click();
  await expect(page.getByRole('heading', {name: '订单已创建', exact: true})).toBeVisible();
  expect(Object.fromEntries(trade)).toMatchObject({
    card_id: '1',
    user_note: 'Local browser regression',
    'extras[0]': 'sample',
    'extras[1]': 'docs',
  });
  expect(trade.has('widget[user_note]')).toBeFalsy();
  expect(await page.evaluate(() => window.__policyViolations)).toEqual([]);
});

for (const [name, patch, message] of [
  ['login-only', {only_user: 1}, '该商品需要登录后购买。'],
  [
    'future sale',
    {seckill_status: 1, seckill_start_time: '2099-01-01 00:00:00', seckill_end_time: '2099-02-01 00:00:00'},
    '抢购尚未开始',
  ],
  [
    'expired sale',
    {seckill_status: 1, seckill_start_time: '2020-01-01 00:00:00', seckill_end_time: '2020-02-01 00:00:00'},
    '本次抢购已结束。',
  ],
]) {
  test(`${name} restrictions disable checkout`, async ({page}) => {
    await page.route('**/user/api/index/commodityDetail?*', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      Object.assign(data.data, patch);
      await route.fulfill({response, json: data});
    });
    await page.goto('/item/101');
    await expect(page.getByText(message, {exact: false}).first()).toBeVisible();
    await expect(page.locator('.product-form button[type=submit]')).toBeDisabled();
  });
}

test('store closure disables checkout even when price and stock are available', async ({page}) => {
  await page.route('**/user/api/storefront/bootstrap*', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.data.closed = true;
    await route.fulfill({response, json: data});
  });
  await page.goto('/item/101');
  await fillCustomer(page);
  await expect(page.getByText('商店暂时停止下单，请稍后再来。', {exact: true}).first()).toBeVisible();
  await expect(page.locator('.product-form button[type=submit]')).toBeDisabled();
});

test('failed private lookups retain the previous result and do not expose secrets in URLs', async ({
  page,
}) => {
  let fail = false;
  await page.route('**/user/api/index/query', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(new URL(route.request().url()).search).toBe('');
    if (fail) await route.fulfill({status: 503, json: {code: 503, msg: '暂时无法查询'}});
    else await route.continue();
  });
  await page.goto('/user/index/query');
  await page.getByLabel('订单号或联系方式', {exact: true}).fill('preview@example.test');
  await page.getByRole('button', {name: '查询订单', exact: true}).click();
  await expect(page.locator('.order-card')).toHaveCount(1);
  fail = true;
  await page.getByLabel('订单号或联系方式', {exact: true}).fill('new@example.test');
  await page.getByRole('button', {name: '查询订单', exact: true}).click();
  await expect(page.getByText(/已保留上次成功查询的结果/)).toBeVisible();
  await expect(page.locator('.order-card')).toHaveCount(1);
  expect(page.url()).not.toContain('@');
  await expect(page.locator('.order-secret')).toHaveCount(0);
});
