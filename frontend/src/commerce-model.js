// Pure transforms for the pinned acg-faka checkout/query contracts. No credentials persist here.
export const isEnabled = value => value === true || value === 1 || value === '1';
const text = value => value == null ? '' : String(value);
const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const reservedFields = new Set([
  ...blockedKeys, 'item_id', 'num', 'race', 'sku', 'card_id', 'coupon', 'pay_id',
  'contact', 'password', 'captcha', 'device', 'request_no',
  'submit', 'reset', 'elements', 'checkValidity', 'reportValidity', 'requestSubmit', 'addEventListener',
  'action', 'method', 'name', 'id', 'attributes', 'children', 'replaceChildren',
]);
// PHP associative arrays with consecutive numeric keys serialize as JSON lists.
const isMap = value => value !== null && typeof value === 'object';
const number = value => (typeof value === 'number' || typeof value === 'string') && text(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const positiveID = value => Number.isSafeInteger(number(value)) && Number(value) > 0;
const orderNumber = value => typeof value === 'string' && /^\d{18}$/.test(value);

export function productIdFromURL(url) {
  const match = url.pathname.match(/^\/(?:item|products?)\/([1-9]\d*)\/?$/);
  const candidate = match?.[1] ?? (/^\/user\/index\/item\/?$/.test(url.pathname) ? url.searchParams.get('commodityId') || url.searchParams.get('id') : null);
  return candidate && /^[1-9]\d*$/.test(candidate) && positiveID(candidate) ? candidate : null;
}

export function quantityBounds(product) {
  return {min: number(product.minimum) > 0 ? Number(product.minimum) : 1, max: number(product.maximum) > 0 ? Number(product.maximum) : null};
}

export function quantityError(product, value) {
  const {min, max} = quantityBounds(product);
  if (!Number.isSafeInteger(min) || (max !== null && (!Number.isSafeInteger(max) || max < min))) return '购买数量配置异常，请联系商家。';
  const count = number(value);
  if (!Number.isSafeInteger(count) || count < 1) return '请输入有效的整数购买数量。';
  if (count < min) return `本商品至少购买 ${min} 件。`;
  if (max !== null && count > max) return `本商品每次最多购买 ${max} 件。`;
  return '';
}

export function productOptions(product) {
  const config = product.config || {};
  let error = isMap(config) ? '' : '商品规格配置异常，请联系商家。';
  function entries(value) {
    if (value == null || value === '') return [];
    if (!isMap(value)) { error = '商品规格配置异常，请联系商家。'; return []; }
    return Object.entries(value);
  }
  const races = entries(config.category).map(([value, price]) => ({value, price}));
  const skus = entries(config.sku).map(([name, values]) => ({name, options: entries(values).map(([value, price]) => ({value, price}))}));
  if (races.some(option => !option.value) || skus.some(group => !group.name || blockedKeys.has(group.name) || /[\[\]\u0000-\u001f]/.test(group.name) || !group.options.length || group.options.some(option => !option.value))) {
    error = '商品规格包含无法提交的选项，请联系商家。';
  }
  return {races, skus, error};
}

export function initialSelection(product) {
  const {races, skus} = productOptions(product);
  return {num: quantityBounds(product).min, race: races[0]?.value ?? '', sku: Object.fromEntries(skus.map(group => [group.name, group.options[0]?.value ?? ''])), coupon: '', card_id: 0};
}

export function isCustomer(product, site) {
  return product.login != null ? isEnabled(product.login) : positiveID(site?.user?.id);
}

export function contactField(type = 0) {
  return [
    {label: '联系方式', type: 'text', autocomplete: 'off', pattern: null},
    {label: '手机号', type: 'tel', autocomplete: 'tel', pattern: '^1[3-9][0-9]{9}$'},
    {label: '邮箱地址', type: 'email', autocomplete: 'email', pattern: '^[^\\s@]+@[^\\s@]+$'},
    {label: 'QQ号', type: 'text', autocomplete: 'off', pattern: '^[1-9][0-9]{4,11}$'},
  ][Number(type)] ?? null;
}

function widgetRequired(widget) {
  if (isEnabled(widget.required)) return true;
  if (!widget.regex) return false;
  // PHP PCRE remains authoritative. Only test empty input here; never run an
  // administrator-supplied expression against customer input on the UI thread.
  try { return text(widget.regex).length > 1024 || !new RegExp(widget.regex).test(''); }
  catch { return true; }
}

export function normalizeWidgets(raw) {
  const fields = [], unsupported = [];
  if (raw == null || raw === '') return {fields, unsupported};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { return {fields, unsupported: ['商品自定义表单配置无法解析，请联系商家。']}; }
  }
  if (!Array.isArray(raw) && !isMap(raw)) return {fields, unsupported: ['商品自定义表单格式不受支持，请联系商家。']};
  const seen = new Set();
  for (const item of Object.values(raw)) {
    const widget = item && typeof item === 'object' ? item : {};
    const name = text(widget.name), label = text(widget.cn || name || '未命名字段');
    const type = text(widget.type);
    if (!['text', 'password', 'number', 'select', 'checkbox', 'radio', 'textarea'].includes(type)) {
      unsupported.push(`“${label}”使用暂不支持的组件（${type || '未知类型'}），请联系商家完成购买。`);
      continue;
    }
    if (!name || /[\s.\[\]\u0000-\u001f\u007f]/u.test(name) || reservedFields.has(name) || seen.has(name)) {
      unsupported.push(`“${label}”的字段名冲突或无法安全提交，请联系商家。`);
      continue;
    }
    seen.add(name);
    const options = new Map();
    if (typeof widget.dict === 'string') {
      for (const pair of widget.dict.split(',')) {
        const separator = pair.indexOf('=');
        if (separator < 0) continue;
        const optionLabel = pair.slice(0, separator).trim(), value = pair.slice(separator + 1).trim();
        if (optionLabel && value) options.set(value, {label: optionLabel, value});
      }
    }
    if (['select', 'checkbox', 'radio'].includes(type) && !options.size) {
      unsupported.push(`“${label}”没有可用的选项，请联系商家。`);
      continue;
    }
    fields.push({name, label, type, placeholder: text(widget.placeholder), required: widgetRequired(widget), options: [...options.values()], serverValidation: Boolean(widget.regex), error: text(widget.error)});
  }
  return {fields, unsupported};
}

export function widgetErrors(widgets, values = {}) {
  const errors = [];
  for (const field of widgets.fields) {
    const value = values[field.name];
    const empty = field.type === 'checkbox' ? !Array.isArray(value) || value.length === 0 : text(value).trim() === '';
    let message = field.required && empty ? `请填写${field.label}。` : '';
    if (!empty && field.options.length) {
      const selected = field.type === 'checkbox' ? value : [value];
      if (!Array.isArray(selected) || selected.some(item => !field.options.some(option => option.value === text(item)))) message = `请重新选择${field.label}。`;
    }
    if (!empty && field.type === 'number' && number(value) === null) message = `${field.label}需要填写数字。`;
    if (message) errors.push({field: field.name, message});
  }
  return errors;
}

export function buildQuoteFields(product, selection) {
  return {
    item_id: product.id, num: Number(selection.num), race: text(selection.race),
    sku: Object.fromEntries(productOptions(product).skus.map(group => [group.name, text(selection.sku?.[group.name])])),
    card_id: positiveID(selection.card_id) ? Number(selection.card_id) : 0, coupon: text(selection.coupon),
  };
}

export function quoteKey(product, selection) {
  const fields = buildQuoteFields(product, selection);
  return JSON.stringify([fields.item_id, fields.num, fields.race, Object.entries(fields.sku).sort(([a], [b]) => a.localeCompare(b)), fields.card_id, fields.coupon]);
}

export function makeQuote(product, selection, valuation, stock) {
  const price = number(valuation?.price), stockState = number(stock?.stock_state ?? stock?.state);
  if (price === null || price < 0) throw new Error('未能取得有效价格，请重新获取价格与库存。');
  if (stockState === null || stockState < 0 || !Number.isInteger(stockState)) throw new Error('未能确认库存状态，请重新获取价格与库存。');
  const count = isEnabled(product.inventory_hidden) ? null : number(stock?.stock);
  return {key: quoteKey(product, selection), price, stock: text(stock?.stock), stockState, count};
}

export function buildTradeFields(product, selection, values, widgets = normalizeWidgets(product.widget)) {
  if (widgets.unsupported.length) throw new Error(widgets.unsupported.join(' '));
  const fields = {...buildQuoteFields(product, selection), pay_id: Number(values.pay_id), contact: text(values.contact).trim(), password: text(values.password), captcha: text(values.captcha).trim()};
  for (const field of widgets.fields) {
    const value = values.widget?.[field.name];
    fields[field.name] = field.type === 'checkbox' ? (Array.isArray(value) ? value.map(text) : []) : text(value);
  }
  return fields;
}

export function availablePayments(data, loggedIn) {
  const seen = new Set();
  return (Array.isArray(data) ? data : []).filter(pay => {
    if (!pay || !positiveID(pay.id) || seen.has(Number(pay.id)) || (!loggedIn && (Number(pay.id) === 1 || pay.handle === '#system'))) return false;
    seen.add(Number(pay.id));
    return true;
  }).map(pay => ({id: Number(pay.id), name: text(pay.name || `支付方式 ${pay.id}`), handle: text(pay.handle)}));
}

export function saleTime(value) {
  return typeof value === 'string' ? Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')) : NaN;
}

export function purchaseRestriction(product, {site, loggedIn = isCustomer(product, site), now = Date.now()} = {}) {
  if (isEnabled(site?.closed)) return {code: 'closed', message: '商店暂时停止下单，请稍后再来。'};
  if (product.status != null && !isEnabled(product.status)) return {code: 'unavailable', message: '该商品目前不可购买。'};
  if (!loggedIn && (isEnabled(product.only_user) || Number(product.purchase_count) > 0 || isEnabled(site?.auth?.force_login))) return {code: 'login', message: '该商品需要登录后购买。'};
  if (isEnabled(product.seckill_status)) {
    const start = saleTime(product.seckill_start_time), end = saleTime(product.seckill_end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return {code: 'sale-invalid', message: '抢购时间配置异常，请联系商家。'};
    if (now < start) return {code: 'sale-upcoming', message: `抢购尚未开始，开始时间：${text(product.seckill_start_time)}。`};
    if (now >= end) return {code: 'sale-ended', message: '本次抢购已结束。'};
  }
  return {code: '', message: ''};
}

export function checkoutReadiness({product, selection, quote, pending = false, payments = [], payId, values = {}, widgets = normalizeWidgets(product.widget), loggedIn = isCustomer(product), site, submitting = false, completed = false, uncertain = false, now = Date.now()}) {
  const blocked = (code, message) => ({ready: false, code, message});
  if (submitting) return blocked('submitting', '正在提交订单，请勿重复操作。');
  if (completed) return blocked('completed', '订单已创建，请查看下方订单结果。');
  if (uncertain) return blocked('uncertain', '尚未确认上次下单结果，请先查询订单。');
  const restriction = purchaseRestriction(product, {site, loggedIn, now});
  if (restriction.code) return blocked(restriction.code, restriction.message);
  if (widgets.unsupported.length) return blocked('widget-unsupported', widgets.unsupported[0]);
  const options = productOptions(product);
  if (options.error) return blocked('variation', options.error);
  const quantity = quantityError(product, selection.num);
  if (quantity) return blocked('quantity', quantity);
  if (Number(selection.card_id) > 0 && Number(selection.num) !== 1) return blocked('card-quantity', '自选卡仅支持购买 1 件，请取消自选或调整数量。');
  if ((options.races.length && !options.races.some(option => option.value === selection.race)) || options.skus.some(group => !group.options.some(option => option.value === selection.sku?.[group.name]))) return blocked('variation', '请选择完整的商品类型与规格。');
  if (pending || !quote || quote.key !== quoteKey(product, selection) || number(quote.price) === null || quote.price < 0) return blocked('quote', '请等待当前规格的价格与库存确认。');
  if (!(quote.stockState > 0) || (quote.count !== null && Number(selection.num) > quote.count)) return blocked('stock', '当前规格库存不足，请调整数量或规格。');
  if (!availablePayments(payments, loggedIn).some(pay => pay.id === Number(payId))) return blocked('payment', '请选择可用的支付方式。');
  if (!loggedIn) {
    const contact = contactField(product.contact_type), value = text(values.contact).trim();
    if (!contact) return blocked('contact', '该商品的联系方式类型暂不支持，请联系商家。');
    if ([...value].length < 3 || (contact.pattern && !new RegExp(contact.pattern).test(value))) return blocked('contact', `请填写有效的${contact.label}。`);
  }
  if (isEnabled(product.password_status) && (!loggedIn || text(values.password) !== '') && [...text(values.password)].length < 6) return blocked('password', '查询密码至少需要 6 个字符。');
  if (isEnabled(product.trade_captcha) && !text(values.captcha).trim()) return blocked('captcha', '请填写图形验证码。');
  const widgetError = widgetErrors(widgets, values.widget)[0];
  if (widgetError) return blocked('widget', widgetError.message);
  return {ready: true, code: '', message: '价格与库存已确认，提交时由商家再次校验。'};
}

export function initialOrderKeyword(url) {
  const value = url.searchParams.get('tradeNo');
  return orderNumber(value) ? value : '';
}

export function orderQueryPath(tradeNo) {
  return orderNumber(tradeNo) ? `/user/index/query?tradeNo=${tradeNo}` : '/user/index/query';
}

export function tradeOutcome(data, payment) {
  if (!data || typeof data.tradeNo !== 'string' || !data.tradeNo.trim() || !Object.hasOwn(data, 'url') || (data.url != null && typeof data.url !== 'string')) throw new Error('未能识别下单结果，请先查询订单确认。');
  const amount = number(data.amount);
  const paid = data.url == null || data.url === '' || payment?.handle === '#system' || Number(payment?.id) === 1 || amount === 0;
  return {tradeNo: data.tradeNo, paid, amount, secret: paid && typeof data.secret === 'string' ? data.secret : '', paymentURL: paid ? '' : data.url};
}

export function tradeFailureNeedsLookup(error) {
  // The shared request helper also uses HTTP 200 for invalid JSON/envelopes;
  // those generic errors do not confirm that an order was rejected.
  return !error?.status || error.status >= 500 || !error.message || [
    '服务暂时没有返回有效数据，请稍后重试',
    '操作未完成，请稍后重试',
  ].includes(error.message);
}

export function orderPresentation(order, details = null) {
  const paid = isEnabled(order.status), delivered = paid && isEnabled(order.delivery_status);
  const protection = order.password;
  const protectedOrder = Object.hasOwn(order, 'password') ? ![false, 0, '0', '', null, undefined].includes(protection) : isEnabled(order.commodity?.password_status);
  const locked = paid && protectedOrder && details === null;
  const rawSecret = details ? details.secret : order.secret;
  const secret = paid && !locked ? text(rawSecret) : '';
  const knownWay = order.commodity?.delivery_way ?? order.delivery_way;
  let kind = 'unpaid', label = '待支付', message = '付款确认后才能查看发货内容。';
  if (paid) {
    if (delivered) {
      kind = 'delivered'; label = '已付款 · 已发货'; message = '请妥善保存发货内容。';
    } else if (Number(knownWay) === 1 || (!locked && secret.trim())) {
      kind = 'manual'; label = '已付款 · 商家处理中'; message = '正在等待商家完成发货，无需再次付款。';
    } else if ((knownWay != null && Number(knownWay) === 0) || (!locked && rawSecret != null && !secret.trim())) {
      kind = 'stock'; label = '已付款 · 等待补货'; message = '付款已确认，正在等待库存补充与发货，无需再次付款。';
    } else {
      kind = 'pending'; label = '已付款 · 待发货'; message = '正在等待补货或商家发货，无需再次付款。';
    }
  }
  return {paid, delivered, protected: protectedOrder, locked, kind, label, message, secret, leaveMessage: paid && !locked ? text(details?.leave_message ?? order.commodity?.leave_message) : '', widget: paid && !locked ? details?.widget ?? null : null};
}

export function pagination(total, page = 1, limit = 10) {
  total = number(total);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('分页数据无效，请重新查询。');
  const pages = Math.max(1, Math.ceil(total / limit));
  return {total, page, limit, pages, previous: page > 1 ? Math.min(page - 1, pages) : null, next: page < pages ? page + 1 : null};
}
