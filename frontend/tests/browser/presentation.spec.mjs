import {test, expect} from '@playwright/test';

test.beforeEach(async ({request}) => {
  await request.post('/__fixture/reset');
});

test('purchase quantity controls stay aligned on desktop and mobile', async ({page}) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.goto('/item/101');
    const input = page.getByLabel('购买数量', {exact: true});
    await expect(input).toBeVisible();
    const boxes = await Promise.all([
      page.getByRole('button', {name: '减少购买数量'}).boundingBox(),
      input.boundingBox(),
      page.getByRole('button', {name: '增加购买数量'}).boundingBox(),
    ]);
    expect(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))).toBeLessThan(4);
    await expect(page.locator('.product-form > fieldset')).toHaveCSS('border-top-width', '0px');
  }
});

test('order metadata keeps each label and its value on one row', async ({page}) => {
  await page.goto('/user/index/query?tradeNo=202610090000000001');
  await expect(page.locator('.order-card')).toHaveCount(1);
  await expect(page.locator('.order-card > .metadata-list > div')).toHaveCount(5);
  const label = await page.locator('.order-card dt').filter({hasText: '订单金额'}).boundingBox();
  const value = await page.locator('.order-card dd').filter({hasText: '¥12.00'}).boundingBox();
  expect(Math.abs(label.y - value.y)).toBeLessThan(4);
});

test('home honors the safe merchant notice and default category without overriding explicit filters', async ({
  page,
}) => {
  await page.route('**/user/api/storefront/bootstrap*', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.data.notice =
      '<p>欢迎使用资源站 <strong>请妥善保管卡密</strong></p><script>window.__unsafeNotice=true</script>';
    data.data.default_category = 11;
    await route.fulfill({response, json: data});
  });
  await page.goto('/');
  await expect(page.getByRole('region', {name: '站点公告'})).toContainText('请妥善保管卡密');
  await expect(page.getByRole('button', {name: '工具套装', exact: true})).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.locator('.resource-card')).toHaveCount(1);
  expect(await page.evaluate(() => window.__unsafeNotice)).toBeUndefined();
  await page.goto('/?category=all');
  await expect(page.locator('.resource-card')).toHaveCount(6);
});

test('home explains store closure without hiding public downloads', async ({page}) => {
  await page.route('**/user/api/storefront/bootstrap*', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.data.closed = true;
    await route.fulfill({response, json: data});
  });
  await page.goto('/');
  await expect(
    page.getByText('商城暂时停止下单。公开资源下载与已有卡密兑换仍可使用。', {exact: true})
  ).toBeVisible();
  await expect(page.locator('[data-resource-id]')).toHaveCount(4);
});

test('a failing commerce service leaves the independent public catalog usable', async ({page}) => {
  await page.route('**/user/api/index/commodity?*', (route) =>
    route.fulfill({status: 503, json: {code: 503}})
  );
  await page.goto('/');
  await expect(page.locator('[data-resource-id]')).toHaveCount(4);
  await expect(
    page.getByText('商城资源暂时无法加载，公开下载和卡密兑换可分别使用。', {exact: true})
  ).toBeVisible();
});

test('cross-page help anchors scroll to the requested section', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/redeem');
  await page.getByRole('link', {name: '遇到问题？查看兑换指南', exact: true}).click();
  await expect(page).toHaveURL(/\/help#redeem$/);
  await expect
    .poll(() => page.locator('#redeem').evaluate((element) => element.getBoundingClientRect().top))
    .toBeLessThan(200);
});

test('resource version labels preserve dates and existing prefixes', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('[data-resource-id="nodequality"] .resource-meta > span').nth(1)).toHaveText(
    '2026-10-07'
  );
  await expect(page.locator('[data-resource-id="termux-setup"] .resource-meta > span').nth(1)).toHaveText(
    'v10'
  );
});
