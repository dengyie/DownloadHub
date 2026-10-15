import {postJSON, safeURL} from '../api.js';
import {
  el,
  icon,
  button,
  link,
  inputField,
  banner,
  loadingState,
  emptyState,
  money,
  copyText,
  renderRichText,
} from '../dom.js';
import {initialOrderKeyword, orderPresentation, pagination} from '../commerce-model.js';
import {pageTitle} from '../site.js';

const mounts = new WeakMap();
const displayText = (value) => (value == null || value === '' ? '—' : String(value));
const displayAmount = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
    ? money(value)
    : '—';
const widgetText = (value) =>
  Array.isArray(value)
    ? value.map(widgetText).join('\n')
    : value && typeof value === 'object'
      ? JSON.stringify(value)
      : value == null
        ? ''
        : String(value);

function busyButton(target, busy, label, name = 'search') {
  target.disabled = busy;
  target.setAttribute('aria-busy', String(busy));
  target.replaceChildren(icon(busy ? 'loader' : name, 18), el('span', {text: label}));
}

export async function renderOrders(root, context) {
  if (context.signal?.aborted) return () => {};
  document.title = pageTitle('订单查询');
  mounts.get(root)?.();
  const page = el('div', {className: 'stack'});
  let stopped = false,
    queryVersion = 0,
    pending = false,
    last = null,
    pendingKey = '';
  let queryController,
    resultScope = new AbortController();
  const limit = 10;
  const alive = () => !stopped && !context.signal?.aborted && root.contains(page);
  const href = (value) => safeURL(value, {base: context.url.href});
  function cleanup() {
    if (stopped) return;
    stopped = true;
    ++queryVersion;
    queryController?.abort();
    resultScope.abort();
    last = null;
    context.signal?.removeEventListener('abort', cleanup);
    if (root.contains(page)) {
      for (const input of page.querySelectorAll('input, textarea')) input.value = '';
      page.replaceChildren();
    }
    if (mounts.get(root) === cleanup) mounts.delete(root);
  }
  mounts.set(root, cleanup);
  context.signal?.addEventListener('abort', cleanup, {once: true});

  const keyword = inputField('订单号或联系方式', 'keywords', {
    id: 'orders-keywords',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    required: true,
    placeholder: '输入订单号或下单时填写的联系方式',
    value: initialOrderKeyword(context.url),
    'aria-describedby': 'orders-privacy',
  });
  keyword.field.append(
    el('p', {
      id: 'orders-privacy',
      className: 'field-help',
      text: '联系方式与查询密码仅通过表单提交，不会保存到浏览器本地或放入网址。',
    })
  );
  const search = button('查询订单', {type: 'submit', className: 'button button-primary'}, 'search');
  const feedback = el('div', {'aria-live': 'polite'});
  const results = el('section', {className: 'stack', 'aria-label': '订单查询结果'});
  const pages = el('nav', {className: 'pagination', 'aria-label': '订单分页'});
  const refresh = button(
    '刷新当前结果',
    {
      className: 'button button-secondary',
      hidden: true,
      onclick: () => {
        if (last) void lookup(last.keywords, last.page);
      },
    },
    'refresh'
  );
  const form = el(
    'form',
    {
      className: 'content-panel stack',
      method: 'post',
      action: '/user/api/index/query',
      role: 'search',
      autocomplete: 'off',
      onsubmit: (event) => {
        event.preventDefault();
        if (!alive() || !form.reportValidity()) return;
        void lookup(keyword.input.value, 1);
      },
    },
    [keyword.field, el('div', {className: 'row'}, [search, refresh]), feedback]
  );
  const support = el('aside', {className: 'side-panel stack'}, [
    el('h2', {className: 'section-title', text: '查询提示'}),
    el('p', {
      className: 'muted',
      text: '付款确认后才会显示发货内容。受保护的订单需要输入下单时设置的查询密码。',
    }),
    el('p', {className: 'muted', text: '已付款但尚未发货的订单，可能正在等待补货或商家处理，请勿重复付款。'}),
    el('p', {className: 'field-help', text: '页面不会自动轮询。需要最新状态时，请手动刷新当前结果。'}),
  ]);
  results.append(emptyState('查询你的订单', '输入订单号或联系方式，查看付款、发货状态与已购内容。'));
  page.append(
    el('header', {className: 'page-heading'}, [
      el('p', {className: 'eyebrow', text: '我的订单'}),
      el('h1', {text: '订单查询'}),
      el('p', {className: 'muted', text: '查看订单进度，取回已购买的内容。'}),
    ]),
    el('div', {className: 'page-layout'}, [el('div', {className: 'stack'}, [form, results, pages]), support])
  );
  root.replaceChildren(page);
  void Promise.resolve(context.sitePromise)
    .then((site) => {
      if (!alive()) return;
      const url = href(site?.support_url);
      if (url)
        support.append(
          link(
            '联系商家',
            url,
            {className: 'button button-secondary', target: '_blank', rel: 'noopener noreferrer'},
            'external-link'
          )
        );
    })
    .catch(() => {});

  function drawPagination() {
    refresh.hidden = !last;
    refresh.disabled = pending;
    pages.replaceChildren();
    if (!last) return;
    const model = pagination(last.total, last.page, limit);
    pages.append(
      button(
        '上一页',
        {
          className: 'button button-secondary',
          disabled: pending || model.previous === null,
          onclick: () => {
            if (last && model.previous) void lookup(last.keywords, model.previous);
          },
        },
        'chevron-left'
      ),
      el('span', {text: `第 ${model.page} 页 / 共 ${model.pages} 页，共 ${model.total} 笔`}),
      button(
        '下一页',
        {
          className: 'button button-secondary',
          disabled: pending || model.next === null,
          onclick: () => {
            if (last && model.next) void lookup(last.keywords, model.next);
          },
        },
        'chevron-right'
      )
    );
  }

  async function lookup(value, requestedPage) {
    if (!alive()) return;
    const keywords = String(value).trim();
    if (!keywords) {
      feedback.replaceChildren(banner('请输入订单号或下单时填写的联系方式。', 'error'));
      keyword.input.focus();
      return;
    }
    const key = JSON.stringify([keywords, requestedPage]);
    if (pending && key === pendingKey) return;
    queryController?.abort();
    const controller = new AbortController();
    queryController = controller;
    const version = ++queryVersion;
    pending = true;
    pendingKey = key;
    busyButton(search, true, '正在查询');
    results.setAttribute('aria-busy', 'true');
    drawPagination();
    feedback.replaceChildren(loadingState('正在查询订单'));
    try {
      const response = await postJSON(
        '/user/api/index/query',
        {keywords, page: requestedPage, limit},
        {signal: controller.signal}
      );
      if (!alive() || version !== queryVersion) return;
      const data = response.data;
      if (
        !Array.isArray(data?.list) ||
        data.list.some(
          (order) =>
            !order || typeof order !== 'object' || typeof order.trade_no !== 'string' || !order.trade_no
        )
      )
        throw new Error('订单列表数据无效，请重试。');
      const model = pagination(data.total, requestedPage, limit);
      if (data.list.length > limit || data.list.length > model.total)
        throw new Error('订单分页数据不完整，请重试。');
      const nextScope = new AbortController();
      const cards = data.list.map((order, index) => orderCard(order, index, nextScope));
      resultScope.abort();
      resultScope = nextScope;
      last = {keywords, page: requestedPage, total: model.total};
      results.replaceChildren(
        el('h2', {className: 'section-title', text: `查询结果（${model.total}）`}),
        ...cards
      );
      if (!cards.length)
        results.append(
          emptyState(
            model.total && requestedPage > model.pages ? '当前页已没有订单' : '未找到订单',
            model.total && requestedPage > model.pages
              ? '订单总数已变化，请使用上一页返回可用页面。'
              : '请核对订单号或下单时填写的联系方式。'
          )
        );
      feedback.replaceChildren();
    } catch (error) {
      if (alive() && version === queryVersion)
        feedback.replaceChildren(
          banner(
            `${error.message || '查询失败，请稍后重试。'}${last ? ' 已保留上次成功查询的结果。' : ''}`,
            'error'
          )
        );
    } finally {
      if (alive() && version === queryVersion) {
        pending = false;
        pendingKey = '';
        busyButton(search, false, '查询订单');
        results.setAttribute('aria-busy', 'false');
        drawPagination();
      }
    }
  }

  function orderCard(order, index, scope) {
    let details = null,
      secretPending = false;
    const card = el('article', {className: 'order-card stack'});
    const active = () => alive() && !scope.signal.aborted && results.contains(card);
    const commodity = order.commodity || {};
    const badge = el('span', {className: 'badge', text: orderPresentation(order).label});
    const cover = href(commodity.cover);
    const copyNotice = el('p', {className: 'field-help', role: 'status'});
    const body = el('div', {className: 'stack'}),
      content = el('div', {className: 'stack'}),
      detailControls = el('div'),
      detailFeedback = el('div', {'aria-live': 'polite'});
    function copyAction(label, value, container) {
      return button(
        label,
        {
          className: 'button button-quiet',
          onclick: async () => {
            if (!active()) return;
            const copied = await copyText(value, container);
            if (active()) copyNotice.textContent = copied ? '已复制。' : '请在文本框中手动复制。';
          },
        },
        'copy'
      );
    }
    const metadata = el('dl', {className: 'metadata-list'});
    const entries = [
      ['订单号', order.trade_no],
      ['订单金额', displayAmount(order.amount)],
      ['购买数量', order.card_num],
      ['下单时间', order.create_time],
    ];
    if (orderPresentation(order).paid) entries.push(['支付时间', order.pay_time]);
    for (const [label, value] of entries)
      metadata.append(el('div', {}, [el('dt', {text: label}), el('dd', {text: displayText(value)})]));
    card.append(
      el('div', {className: 'order-header'}, [
        cover
          ? el('img', {
              className: 'resource-icon',
              src: cover,
              alt: '',
              width: 48,
              height: 48,
              loading: 'lazy',
              referrerpolicy: 'no-referrer',
            })
          : el('div', {className: 'resource-icon'}, icon('layers', 24)),
        el('h2', {className: 'section-title', text: String(commodity.name || '商品订单')}),
        badge,
      ]),
      metadata,
      copyAction('复制订单号', order.trade_no, card),
      body,
      copyNotice
    );
    body.append(content, detailControls, detailFeedback);

    function renderDetails() {
      const view = orderPresentation(order, details);
      badge.textContent = view.label;
      content.replaceChildren(banner(view.message));
      detailControls.replaceChildren();
      if (!view.paid) return;
      if (view.secret) {
        const secret = el('section', {className: 'stack'}, [
          el('h3', {className: 'section-title', text: view.delivered ? '发货内容' : '商家发货信息'}),
          el('pre', {className: 'order-secret', tabindex: 0, text: view.secret}),
        ]);
        secret.append(copyAction('复制发货内容', view.secret, secret));
        content.append(secret);
      } else if (view.delivered && !view.locked)
        content.append(
          el('p', {className: 'field-help', text: '订单已标记发货，暂未取得发货内容，可以再次查看发货详情。'})
        );
      if (view.leaveMessage)
        content.append(
          el('section', {className: 'stack'}, [
            el('h3', {className: 'section-title', text: '商家留言'}),
            renderRichText(view.leaveMessage),
          ])
        );
      if (view.widget && typeof view.widget === 'object') {
        const fields = el('dl', {className: 'metadata-list'});
        for (const [name, item] of Object.entries(view.widget)) {
          const entry = item && typeof item === 'object' && !Array.isArray(item) ? item : {value: item};
          fields.append(
            el('div', {}, [
              el('dt', {text: String(entry.cn || name)}),
              el('dd', {text: widgetText(entry.value)}),
            ])
          );
        }
        if (fields.childNodes.length)
          content.append(
            el('section', {className: 'stack'}, [
              el('h3', {className: 'section-title', text: '订单填写信息'}),
              fields,
            ])
          );
      }
      if (view.protected) {
        const password = inputField('查询密码', 'password', {
          id: `order-password-${index}`,
          type: 'password',
          autocomplete: 'off',
          required: true,
          'aria-describedby': `order-password-help-${index}`,
        });
        password.field.append(
          el('p', {
            id: `order-password-help-${index}`,
            className: 'field-help',
            text: details
              ? '再次输入查询密码可刷新详情；已取得的内容会继续保留。'
              : '此订单已设置查询密码，验证后才能查看发货内容。',
          })
        );
        const unlock = button(
          details ? '验证并刷新' : '验证并查看',
          {type: 'submit', className: 'button button-primary'},
          'lock'
        );
        const unlockForm = el(
          'form',
          {
            className: 'stack',
            method: 'post',
            action: '/user/api/index/secret',
            autocomplete: 'off',
            onsubmit: (event) => {
              event.preventDefault();
              if (active() && !secretPending && unlockForm.reportValidity())
                void fetchSecret(password.input.value, unlock, password.input);
            },
          },
          [password.field, unlock]
        );
        detailControls.append(unlockForm);
      } else {
        const fetch = button(
          details ? '刷新发货详情' : '查看发货详情',
          {
            className: 'button button-secondary',
            onclick: () => {
              void fetchSecret('', fetch);
            },
          },
          'eye'
        );
        detailControls.append(fetch);
      }
    }
    async function fetchSecret(password, trigger, passwordInput) {
      if (!active() || secretPending || !orderPresentation(order).paid) return;
      secretPending = true;
      const label = trigger.textContent;
      busyButton(trigger, true, '正在获取', passwordInput ? 'lock' : 'eye');
      if (passwordInput) passwordInput.disabled = true;
      detailFeedback.replaceChildren();
      try {
        const response = await postJSON(
          '/user/api/index/secret',
          {tradeNo: order.trade_no, password},
          {signal: scope.signal}
        );
        if (!active()) return;
        const data = response.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !Object.hasOwn(data, 'secret') ||
          (data.secret != null && typeof data.secret !== 'string')
        )
          throw new Error('发货详情数据不完整，请重试。');
        details = data;
        if (passwordInput) passwordInput.value = '';
        renderDetails();
      } catch (error) {
        if (active())
          detailFeedback.replaceChildren(banner(error.message || '获取发货详情失败，请重试。', 'error'));
      } finally {
        secretPending = false;
        if (active()) {
          if (body.contains(trigger)) busyButton(trigger, false, label, passwordInput ? 'lock' : 'eye');
          if (passwordInput) {
            passwordInput.disabled = false;
            passwordInput.value = '';
          }
        }
      }
    }
    renderDetails();
    return card;
  }

  const prefill = initialOrderKeyword(context.url);
  if (prefill) void lookup(prefill, 1);
  return cleanup;
}
