import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {formFields, request, APIError} from '../src/api.js';
import {
  productIdFromURL,
  productOptions,
  initialSelection,
  quantityBounds,
  quantityError,
  contactField,
  isCustomer,
  normalizeWidgets,
  widgetErrors,
  buildQuoteFields,
  quoteKey,
  makeQuote,
  buildTradeFields,
  availablePayments,
  purchaseRestriction,
  checkoutReadiness,
  tradeOutcome,
  tradeFailureNeedsLookup,
  orderPresentation,
  initialOrderKeyword,
  orderQueryPath,
  pagination,
} from '../src/commerce-model.js';
import {renderProduct} from '../src/pages/product.js';
import {renderOrders} from '../src/pages/orders.js';

const product = {
  id: 7,
  login: false,
  only_user: 0,
  delivery_way: 0,
  contact_type: 2,
  password_status: 1,
  coupon: 1,
  minimum: 1,
  maximum: 5,
  draft_status: 1,
  config: {category: {专业版: '12.00', 基础版: '8.00'}, sku: {地区: {中国: 0, 日本: 2}}},
};
const selection = {...initialSelection(product), coupon: 'SAVE', card_id: 0};
const payments = [{id: 2, name: '在线支付', handle: 'gateway'}];
const values = {
  pay_id: 2,
  contact: 'buyer@example.test',
  password: 'secret-123',
  captcha_id: '',
  captcha_code: '',
  widget: {},
};
const quoted = (changes = {}, stock = {stock: 5, stock_state: 1}) =>
  makeQuote(product, {...selection, ...changes}, {price: '12.00'}, stock);
const readiness = (overrides = {}) =>
  checkoutReadiness({
    product,
    selection,
    quote: quoted(),
    payments,
    payId: 2,
    values,
    loggedIn: false,
    ...overrides,
  });

test('product URLs accept known item routes and IDs, never arbitrary path or query values', () => {
  for (const path of ['/item/7', '/product/7', '/user/index/item?commodityId=7']) {
    assert.equal(productIdFromURL(new URL(path, 'https://shop.test')), '7');
  }
  for (const path of ['/item/0', '/item/javascript:alert(1)', '/orders?id=7', '/item/1.5']) {
    assert.equal(productIdFromURL(new URL(path, 'https://shop.test')), null);
  }
});

test('initial selections retain original race and SKU keys and minimum quantity', () => {
  assert.deepEqual(initialSelection({...product, minimum: 3}), {
    num: 3,
    race: '专业版',
    sku: {地区: '中国'},
    coupon: '',
    card_id: 0,
  });
  assert.equal(productOptions(product).skus[0].options[1].value, '日本');
  assert.ok(productOptions({...product, config: {sku: {地区: {}}}}).error);
  assert.ok(productOptions({...product, config: {sku: JSON.parse('{"__proto__":{"a":1}}')}}).error);
});

test('numeric PHP option maps can arrive as JSON arrays without losing their keys', () => {
  const numeric = {...product, config: {category: [12, 18], sku: {等级: [0, 5]}}};
  assert.equal(productOptions(numeric).error, '');
  const selected = initialSelection(numeric);
  assert.equal(selected.race, '0');
  assert.deepEqual(selected.sku, {等级: '0'});
  assert.equal(formFields(buildQuoteFields(numeric, selected)).get('sku[等级]'), '0');
});

test('quantity constraints do not round fractions, permit zero, or erase a minimum for card selection', () => {
  const bounded = {...product, minimum: 3, maximum: 7};
  assert.deepEqual(quantityBounds(bounded), {min: 3, max: 7});
  for (const value of ['', '0', '-1', '2', '3.5', '8', 'Infinity']) assert.ok(quantityError(bounded, value));
  for (const value of ['3', 7]) assert.equal(quantityError(bounded, value), '');
  assert.equal(quantityBounds({...product, maximum: 0}).max, null);
  assert.ok(quantityError({...product, minimum: 6, maximum: 2}, 6));
  assert.equal(readiness({selection: {...selection, num: 2, card_id: 91}}).code, 'card-quantity');
});

test('contact types and login detection match the PHP helper and detail snapshot', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((type) => contactField(type).label),
    ['联系方式', '手机号', '邮箱地址', 'QQ号']
  );
  assert.equal(contactField(1).type, 'tel');
  assert.equal(contactField(2).type, 'email');
  assert.equal(contactField(99), null);
  assert.equal(isCustomer({login: false}, {user: {id: 3}}), false);
  assert.equal(isCustomer({login: '1'}, null), true);
  assert.equal(isCustomer({}, {user: {id: 3}}), true);
  assert.equal(readiness({values: {...values, contact: 'bad'}}).code, 'contact');
  for (const [contact_type, contact] of [
    [0, '用户甲'],
    [1, '13800138000'],
    [2, 'a@b.test'],
    [3, '12345'],
  ]) {
    assert.equal(readiness({product: {...product, contact_type}, values: {...values, contact}}).ready, true);
  }
});

test('widgets preserve helper label=value direction, embedded equals, arrays and optional regex fields', () => {
  const widgets = normalizeWidgets([
    {name: 'account', cn: '账号', type: 'text', regex: '^.+$', error: '请填写账号'},
    {name: 'note', cn: '备注', type: 'textarea', regex: '^.*$'},
    {name: 'plan', cn: '方案', type: 'select', dict: '基础版=basic, 专业版=plan=pro', required: true},
    {name: 'extras', cn: '附加项', type: 'checkbox', dict: '备份=backup,加速=fast', required: 1},
    {name: 'optional_number', type: 'number', regex: '^[0-9]*$'},
  ]);
  assert.deepEqual(widgets.unsupported, []);
  assert.deepEqual(widgets.fields[2].options, [
    {label: '基础版', value: 'basic'},
    {label: '专业版', value: 'plan=pro'},
  ]);
  assert.equal(widgets.fields[0].required, true);
  assert.equal(widgets.fields[1].required, false);
  assert.equal(widgets.fields[4].required, false);
  assert.deepEqual(
    widgetErrors(widgets, {}).map((error) => error.field),
    ['account', 'plan', 'extras']
  );
  const widget = {
    account: 'name<&>',
    plan: 'plan=pro',
    extras: ['backup', 'fast'],
    note: '',
    optional_number: '',
  };
  assert.deepEqual(widgetErrors(widgets, widget), []);
  assert.ok(widgetErrors(widgets, {...widget, plan: 'not-configured'}).length);
  assert.ok(widgetErrors(widgets, {...widget, extras: ['not-configured']}).length);
  const fields = buildTradeFields(product, selection, {...values, widget}, widgets);
  const encoded = formFields(fields);
  assert.equal(encoded.get('account'), 'name<&>');
  assert.equal(encoded.get('plan'), 'plan=pro');
  assert.equal(encoded.get('extras[0]'), 'backup');
  assert.equal(encoded.get('extras[1]'), 'fast');
  assert.equal(encoded.has('widget[account]'), false);
});

test('unknown, plugin, malformed, duplicate and colliding widgets explicitly block checkout', () => {
  for (const widget of [
    [{type: 'custom', name: 'human_check', cn: '人机验证'}],
    [{type: 'file', name: 'upload'}],
    [{type: 'text', name: 'pay_id'}],
    [{type: 'text', name: 'captcha_id'}],
    [{type: 'text', name: 'captcha_code'}],
    [{type: 'text', name: '__proto__'}],
    [{type: 'text', name: 'contact.extra'}],
    [
      {type: 'text', name: 'x'},
      {type: 'number', name: 'x'},
    ],
    [{type: 'select', name: 'empty', dict: ''}],
    '{broken',
  ]) {
    const widgets = normalizeWidgets(widget);
    assert.ok(widgets.unsupported.length);
    assert.equal(readiness({widgets}).code, 'widget-unsupported');
    assert.throws(() => buildTradeFields(product, selection, values, widgets));
  }
});

test('quote and trade fields use exact backend names and isolate sensitive values from quote requests', () => {
  const chosen = {...selection, num: 1, card_id: 91, sku: {地区: '日本'}};
  assert.deepEqual(buildQuoteFields(product, chosen), {
    item_id: 7,
    num: 1,
    race: '专业版',
    sku: {地区: '日本'},
    card_id: 91,
    coupon: 'SAVE',
  });
  const fields = buildTradeFields(product, chosen, {
    ...values,
    contact: ' buyer@example.test ',
    password: ' exact password ',
    captcha_id: 'a'.repeat(22),
    captcha_code: ' ab23 ',
  });
  assert.equal(fields.contact, 'buyer@example.test');
  assert.equal(fields.password, ' exact password ');
  assert.equal(fields.pay_id, 2);
  assert.equal(fields.captcha_id, 'a'.repeat(22));
  assert.equal(fields.captcha_code, 'ab23');
  assert.equal(Object.hasOwn(fields, 'captcha'), false);
  assert.equal(formFields(fields).get('sku[地区]'), '日本');
  for (const name of ['contact', 'password', 'captcha_id', 'captcha_code', 'pay_id', 'widget'])
    assert.equal(Object.hasOwn(buildQuoteFields(product, chosen), name), false);
});

test('every price-affecting choice invalidates a prior quote, including out-of-order completion', () => {
  const quote = quoted();
  for (const change of [{race: '基础版'}, {sku: {地区: '日本'}}, {num: 2}, {coupon: ''}, {card_id: 91}]) {
    const changed = {...selection, ...change};
    assert.notEqual(quoteKey(product, changed), quote.key);
    assert.equal(readiness({selection: changed, quote}).code, 'quote');
    assert.equal(readiness({selection: changed, quote: quoted(change)}).ready, true);
  }
  assert.equal(readiness({pending: true}).code, 'quote');
  assert.equal(readiness({quote: null}).code, 'quote');
});

test('only complete authoritative quotes unlock payment, and zero is a valid price', () => {
  assert.equal(readiness().ready, true);
  assert.equal(
    readiness({quote: makeQuote(product, selection, {price: '0.00'}, {stock: '充足', stock_state: 3})}).ready,
    true
  );
  assert.equal(
    readiness({quote: makeQuote(product, selection, {price: 12}, {stock: 0, stock_state: 0})}).code,
    'stock'
  );
  assert.equal(
    readiness({selection: {...selection, num: 3}, quote: quoted({num: 3}, {stock: 2, stock_state: 1})}).code,
    'stock'
  );
  assert.equal(makeQuote(product, selection, {price: 12}, {stock: 5, state: 1}).stockState, 1);
  for (const price of [undefined, null, '', 'not-a-price', '-1', Infinity]) {
    assert.throws(() => makeQuote(product, selection, {price}, {stock: 5, stock_state: 1}));
  }
  assert.throws(() => makeQuote(product, selection, {price: 12}, {stock: '充足'}));
  assert.equal(
    readiness({
      product: {...product, inventory_hidden: 1},
      selection: {...selection, num: 3},
      quote: makeQuote(
        {...product, inventory_hidden: 1},
        {...selection, num: 3},
        {price: 36},
        {stock: '充足', stock_state: 3}
      ),
    }).ready,
    true
  );
});

test('guest payment lists exclude balance even if the API accidentally supplies it', () => {
  const all = [
    {id: 1, name: '余额', handle: '#system'},
    ...payments,
    {id: 5, name: '余额别名', handle: '#system'},
  ];
  assert.deepEqual(
    availablePayments(all, false).map((pay) => pay.id),
    [2]
  );
  assert.deepEqual(
    availablePayments(all, true).map((pay) => pay.id),
    [1, 2, 5]
  );
  assert.equal(readiness({payId: 1, payments: all}).code, 'payment');
  assert.equal(readiness({payId: 99}).code, 'payment');
  assert.equal(readiness({payments: []}).code, 'payment');
});

test('purchase restrictions and in-flight/completed trade locks override otherwise valid checkout', () => {
  assert.equal(readiness({product: {...product, only_user: 1}}).code, 'login');
  assert.equal(readiness({site: {closed: true}}).code, 'closed');
  assert.equal(readiness({submitting: true}).code, 'submitting');
  assert.equal(readiness({completed: true}).code, 'completed');
  assert.equal(readiness({uncertain: true}).code, 'uncertain');
  assert.equal(readiness({values: {...values, password: '123'}}).code, 'password');
  assert.equal(readiness({product: {...product, trade_captcha: 1}}).code, 'captcha');
  assert.equal(readiness({loggedIn: true, values: {...values, contact: '', password: ''}}).ready, true);
  const timed = {
    ...product,
    seckill_status: 1,
    seckill_start_time: '2026-10-09T00:00:00Z',
    seckill_end_time: '2026-10-09T01:00:00Z',
  };
  assert.equal(purchaseRestriction(timed, {now: Date.parse('2026-10-08T23:59:59Z')}).code, 'sale-upcoming');
  assert.equal(purchaseRestriction(timed, {now: Date.parse('2026-10-09T00:30:00Z')}).code, '');
  assert.equal(purchaseRestriction(timed, {now: Date.parse('2026-10-09T01:00:00Z')}).code, 'sale-ended');
  assert.equal(purchaseRestriction({...timed, seckill_end_time: 'bad'}).code, 'sale-invalid');
});

test('PHP Shanghai sale windows do not change with the customer timezone', () => {
  const moduleURL = new URL('../src/commerce-model.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {saleTime, purchaseRestriction} from ${JSON.stringify(moduleURL)};
    const product = {seckill_status: 1, seckill_start_time: '2026-10-09 08:00:00', seckill_end_time: '2026-10-09 09:00:00'};
    assert.equal(saleTime(product.seckill_start_time), Date.parse('2026-10-09T00:00:00Z'));
    assert.equal(purchaseRestriction(product, {now: Date.parse('2026-10-08T23:59:59Z')}).code, 'sale-upcoming');
    assert.equal(purchaseRestriction(product, {now: Date.parse('2026-10-09T00:30:00Z')}).code, '');
    assert.equal(purchaseRestriction(product, {now: Date.parse('2026-10-09T01:00:01Z')}).code, 'sale-ended');
  `;
  for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {...process.env, TZ: timezone},
      stdio: 'pipe',
    });
});

test('trade results distinguish a cashier from free/balance completion and withhold unpaid secrets', () => {
  const response = {
    tradeNo: '202610090001234567',
    secret: 'private',
    url: '/user/pay/order.202610090001234567.1',
    amount: '12.00',
  };
  const payment = payments[0];
  assert.equal(tradeOutcome(response, payment).paid, false);
  assert.equal(tradeOutcome(response, payment).secret, '');
  assert.equal(tradeOutcome({...response, url: ''}, payment).paid, true);
  assert.equal(tradeOutcome({...response, amount: '0.00'}, payment).paid, true);
  assert.equal(tradeOutcome(response, {id: 1, handle: '#system'}).secret, 'private');
  assert.equal(tradeOutcome({...response, amount: undefined}, payment).amount, null);
  assert.throws(() => tradeOutcome({tradeNo: response.tradeNo, secret: 'private'}, payment));
  assert.throws(() => tradeOutcome({...response, tradeNo: ''}, payment));
  assert.throws(() => tradeOutcome({...response, url: {}}, payment));
});

test('a malformed successful HTTP trade response requires lookup before another order, without replaying POST', async () => {
  let calls = 0;
  await assert.rejects(
    request('/user/api/order/trade', {
      method: 'POST',
      fields: buildTradeFields(product, selection, values),
      fetcher: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('truncated JSON');
          },
        };
      },
    }),
    (error) => {
      assert.equal(tradeFailureNeedsLookup(error), true);
      return true;
    }
  );
  assert.equal(calls, 1);
  assert.equal(tradeFailureNeedsLookup(new APIError('网络连接失败')), true);
  assert.equal(tradeFailureNeedsLookup(new APIError('服务异常', {status: 502})), true);
  assert.equal(tradeFailureNeedsLookup(new APIError('验证码错误', {status: 200})), false);
});

test('unpaid orders cannot reveal secret, widgets, or rich leave messages, even in a contradictory payload', () => {
  const view = orderPresentation(
    {status: 0, delivery_status: 1, secret: 'MUST NOT SHOW', commodity: {leave_message: '<p>private</p>'}},
    {secret: 'ALSO PRIVATE', widget: {account: 'private'}}
  );
  assert.equal(view.paid, false);
  assert.equal(view.kind, 'unpaid');
  assert.equal(view.secret, '');
  assert.equal(view.leaveMessage, '');
  assert.equal(view.widget, null);
});

test('paid pending stock, manual delivery, unknown protected delivery, and completed delivery stay distinct', () => {
  const base = {status: '1', delivery_status: 0, password: false, commodity: {name: '商品'}};
  assert.equal(orderPresentation({...base, secret: ''}).kind, 'stock');
  assert.equal(orderPresentation({...base, secret: '正在发货中，请耐心等待'}).kind, 'manual');
  assert.equal(orderPresentation({...base, password: true}).kind, 'pending');
  assert.equal(orderPresentation({...base, password: true, commodity: {delivery_way: 0}}).kind, 'stock');
  const delivered = orderPresentation({...base, delivery_status: '1', secret: 'KEY\nhttps://files.test/a'});
  assert.equal(delivered.kind, 'delivered');
  assert.equal(delivered.secret, 'KEY\nhttps://files.test/a');
});

test('password protection follows the actual order and only unlocks after a successful secret response', () => {
  const order = {
    status: 1,
    delivery_status: 1,
    password: true,
    secret: 'unexpected secret',
    commodity: {password_status: 1, leave_message: 'private instructions'},
  };
  assert.equal(orderPresentation(order).locked, true);
  assert.equal(orderPresentation(order).secret, '');
  assert.equal(orderPresentation(order).leaveMessage, '');
  const unlocked = orderPresentation(order, {
    secret: 'unlocked',
    widget: {account: {cn: '账号', value: '<text>'}},
  });
  assert.equal(unlocked.secret, 'unlocked');
  assert.equal(unlocked.protected, true, 'refreshing a protected order must ask for its password again');
  assert.equal(unlocked.locked, false);
  assert.equal(orderPresentation({...order, password: false}).locked, false);
});

test('legacy null and empty order passwords do not inherit a product-level password requirement', () => {
  for (const password of [null, '', false, 0]) {
    const view = orderPresentation({
      status: 1,
      delivery_status: 1,
      password,
      secret: 'delivered',
      commodity: {password_status: 1},
    });
    assert.equal(view.locked, false);
    assert.equal(view.secret, 'delivered');
  }
  assert.equal(
    orderPresentation({status: 1, delivery_status: 1, commodity: {password_status: 1}}).locked,
    true
  );
});

test('order URL helpers accept only the upstream 18-digit order number, never contacts or passwords', () => {
  const number = '202610090001234567';
  assert.equal(initialOrderKeyword(new URL(`https://shop.test/orders?tradeNo=${number}`)), number);
  assert.equal(orderQueryPath(number), `/user/index/query?tradeNo=${number}`);
  for (const input of [
    'buyer@example.test',
    '13800138000',
    'secret',
    '123',
    '202610090001234567&password=x',
  ]) {
    assert.equal(
      initialOrderKeyword(
        new URL(`https://shop.test/orders?tradeNo=${encodeURIComponent(input)}&contact=ignored`)
      ),
      ''
    );
    assert.equal(orderQueryPath(input), '/user/index/query');
  }
  assert.equal(initialOrderKeyword(new URL('https://shop.test/orders?keywords=buyer@example.test')), '');
});

test('pagination obeys totals and provides a reachable previous page after totals shrink', () => {
  assert.deepEqual(pagination(0, 1, 10), {
    total: 0,
    page: 1,
    limit: 10,
    pages: 1,
    previous: null,
    next: null,
  });
  assert.equal(pagination(21, 1, 10).next, 2);
  assert.equal(pagination(21, 3, 10).next, null);
  assert.equal(pagination(21, 3, 10).previous, 2);
  assert.equal(pagination(8, 4, 10).previous, 1);
  assert.throws(() => pagination('bad', 1, 10));
  assert.throws(() => pagination(-1, 1, 10));
});

test('already-aborted page mounts perform no DOM or API work', async () => {
  const controller = new AbortController();
  controller.abort();
  const root = new Proxy(
    {},
    {
      get() {
        throw new Error('stale DOM access');
      },
    }
  );
  const context = {
    url: new URL('https://shop.test/item/7'),
    signal: controller.signal,
    navigate() {
      throw new Error('stale navigation');
    },
    sitePromise: Promise.resolve(null),
  };
  for (const render of [renderProduct, renderOrders]) {
    const cleanup = await render(root, context);
    assert.equal(typeof cleanup, 'function');
    cleanup();
  }
});
