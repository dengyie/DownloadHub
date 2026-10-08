import {postJSON} from '../api.js';
import {el,icon,link,button,banner,emptyState,loadingState,setBusy,money,formatDate,copyText,renderRichText} from '../dom.js';
import {initialOrderKeyword, orderPresentation, pagination} from '../commerce-model.js';

export async function renderOrders(root, {url, signal}) {
  document.title = '订单查询 · MangoQWQ 资源站';
  const initialKeyword = initialOrderKeyword(url);

  root.append(el('div', {className: 'page-heading'}, [
    el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [link('资源广场', '/'), icon('chevron-right', 12), el('span', {text: '订单查询'})]),
  ]));

  const queryPanel = el('section', {className: 'content-panel', style: 'max-width: 640px; margin: 0 auto;'});
  const resultsContainer = el('div', {className: 'order-results', style: 'margin-top: 1.5rem;'});

  const queryTypeTabs = el('div', {style: 'display: flex; gap: 0.5rem; margin-bottom: 1.25rem;'});
  let queryMode = initialKeyword ? 'tradeNo' : 'contact';

  const tradeNoInput = el('input', {placeholder: '请输入18位订单编号', value: initialKeyword, autocomplete: 'off'});
  const contactInput = el('input', {placeholder: '请输入下单时填写的联系方式', autocomplete: 'off'});
  const passwordInput = el('input', {type: 'password', placeholder: '请输入下单时设置的查询密码（如未设置留空）', autocomplete: 'off'});
  const searchBtn = button('查询订单', {type: 'submit', className: 'button button-primary button-wide'}, 'search');
  const formStatus = el('div', {className: 'form-status'});

  const dynamicFields = el('div');

  function renderQueryFields() {
    dynamicFields.replaceChildren();
    if (queryMode === 'tradeNo') {
      dynamicFields.append(
        el('div', {className: 'form-field'}, [el('label', {text: '订单号'}), tradeNoInput]),
        el('div', {className: 'form-field'}, [el('label', {text: '查询密码（若下单时设置）'}), passwordInput]),
      );
    } else {
      dynamicFields.append(
        el('div', {className: 'form-field'}, [el('label', {text: '联系方式'}), contactInput]),
        el('div', {className: 'form-field'}, [el('label', {text: '查询密码（若下单时设置）'}), passwordInput]),
      );
    }
  }

  const byTradeBtn = button('按订单号查询', {
    className: `button button-sm ${queryMode === 'tradeNo' ? 'button-primary' : 'button-secondary'}`,
    onclick: () => { queryMode = 'tradeNo'; updateMode(); },
  });
  const byContactBtn = button('按联系方式查询', {
    className: `button button-sm ${queryMode === 'contact' ? 'button-primary' : 'button-secondary'}`,
    onclick: () => { queryMode = 'contact'; updateMode(); },
  });
  queryTypeTabs.append(byTradeBtn, byContactBtn);

  function updateMode() {
    byTradeBtn.className = `button button-sm ${queryMode === 'tradeNo' ? 'button-primary' : 'button-secondary'}`;
    byContactBtn.className = `button button-sm ${queryMode === 'contact' ? 'button-primary' : 'button-secondary'}`;
    renderQueryFields();
  }

  const form = el('form', {onsubmit: e => { e.preventDefault(); doQuery(); }}, [
    el('h1', {text: '订单查询'}),
    el('p', {className: 'detail-description', text: '查询历史购买的卡密或商品交付信息。无需登录即可通过订单号或联系方式查询。'}),
    queryTypeTabs,
    dynamicFields,
    formStatus,
    searchBtn,
  ]);

  queryPanel.append(form);
  root.append(queryPanel, resultsContainer);
  renderQueryFields();

  let currentPage = 1;

  async function doQuery(page = 1) {
    currentPage = page;
    setBusy(searchBtn, true, '正在查询…');
    formStatus.replaceChildren();
    resultsContainer.replaceChildren(loadingState('正在检索订单记录…'));

    const payload = {
      page: String(currentPage),
      limit: '10',
    };
    if (queryMode === 'tradeNo') {
      const tn = tradeNoInput.value.trim();
      if (!tn) {
        formStatus.replaceChildren(banner('请输入有效的订单编号', 'error'));
        setBusy(searchBtn, false);
        resultsContainer.replaceChildren();
        return;
      }
      payload.tradeNo = tn;
      if (passwordInput.value) payload.password = passwordInput.value;
    } else {
      const ct = contactInput.value.trim();
      if (!ct) {
        formStatus.replaceChildren(banner('请输入下单时填写的联系方式', 'error'));
        setBusy(searchBtn, false);
        resultsContainer.replaceChildren();
        return;
      }
      payload.keywords = ct;
      if (passwordInput.value) payload.password = passwordInput.value;
    }

    try {
      const res = await postJSON('/user/api/index/query', payload, {signal});
      renderResults(res.data, res.total || 0);
    } catch (err) {
      if (signal.aborted) return;
      resultsContainer.replaceChildren(emptyState('未查询到订单', err.message || '请确认输入的订单号或联系方式正确'));
    } finally {
      setBusy(searchBtn, false);
    }
  }

  function renderResults(orders, total) {
    resultsContainer.replaceChildren();
    const list = Array.isArray(orders) ? orders : (orders ? [orders] : []);
    if (list.length === 0) {
      resultsContainer.append(emptyState('未查询到订单', '没有匹配的订单记录，请核对信息后重新查询。'));
      return;
    }

    list.forEach(order => {
      const view = orderPresentation(order);
      const card = el('div', {className: 'content-panel', style: 'margin-bottom: 1rem;'});

      const head = el('div', {style: 'display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; margin-bottom: 0.75rem;'}, [
        el('div', {}, [
          el('h3', {style: 'margin: 0; font-size: 1.1rem;', text: order.commodity?.name || '商品'}),
          el('p', {className: 'small', style: 'color: var(--color-text-muted); margin: 0.25rem 0 0;', text: `订单号：${order.trade_no || order.tradeNo || '—'}`}),
        ]),
        el('div', {style: 'text-align: right;'}, [
          el('span', {className: `badge ${view.paid ? 'badge-card' : 'notice-warning'}`, text: view.paid ? (view.kind === 'delivered' ? '已发货' : '处理中') : '未支付'}),
          el('div', {style: 'font-weight: 700; margin-top: 0.25rem;', text: money(order.price)}),
        ]),
      ]);

      const meta = el('dl', {className: 'metadata-list', style: 'margin-bottom: 0.75rem;'}, [
        ['下单时间', formatDate(order.create_time)],
        ['购买数量', `${order.num || 1} 件`],
      ].map(([k, v]) => el('div', {}, [el('dt', {text: k}), el('dd', {text: v})])));

      const content = el('div', {className: 'order-delivery-content'});

      if (!view.paid) {
        content.append(banner('该订单尚未完成支付，请使用支付链接完成付款或重新下单。', 'warning'));
      } else if (view.locked) {
        const unlockPwd = el('input', {type: 'password', placeholder: '输入查询密码以查看发货卡密'});
        const unlockBtn = button('解锁卡密', {className: 'button button-primary'}, 'lock');
        const unlockMsg = el('div', {className: 'form-status'});
        unlockBtn.addEventListener('click', async () => {
          if (!unlockPwd.value) return;
          setBusy(unlockBtn, true, '正在解锁…');
          unlockMsg.replaceChildren();
          try {
            const secRes = await postJSON('/user/api/index/secret', {
              trade_no: order.trade_no || order.tradeNo,
              password: unlockPwd.value,
            }, {signal});
            const unlockedView = orderPresentation(order, secRes.data || secRes);
            renderDeliveredSecret(content, unlockedView);
          } catch (err) {
            unlockMsg.replaceChildren(banner(err.message || '查询密码错误', 'error'));
          } finally {
            setBusy(unlockBtn, false);
          }
        });
        content.append(
          banner('发货信息已设密码保护，请输入查询密码解锁查看。', 'info'),
          el('div', {style: 'display: flex; gap: 0.5rem; margin-top: 0.5rem;'}, [unlockPwd, unlockBtn]),
          unlockMsg
        );
      } else if (view.kind === 'delivered') {
        renderDeliveredSecret(content, view);
      } else if (view.kind === 'manual') {
        content.append(banner('在线发货商品，商家正在为您配货，请耐心等待或联系客服。', 'info'));
      } else if (view.kind === 'stock') {
        content.append(banner('库存配货中，请稍后刷新本页查看最新发货状态。', 'info'));
      }

      card.append(head, meta, content);
      resultsContainer.append(card);
    });

    const pag = pagination(total, currentPage, 10);
    if (pag.pages > 1) {
      const pagEl = el('div', {className: 'pagination', style: 'margin-top: 1rem;'});
      if (pag.previous) {
        pagEl.append(button('上一页', {onclick: () => doQuery(pag.previous)}, 'chevron-left'));
      }
      pagEl.append(el('span', {text: `第 ${pag.page} / ${pag.pages} 页`}));
      if (pag.next) {
        pagEl.append(button('下一页', {onclick: () => doQuery(pag.next)}, 'chevron-right'));
      }
      resultsContainer.append(pagEl);
    }
  }

  function renderDeliveredSecret(container, view) {
    container.replaceChildren();
    if (!view.secret) return;

    const copyBtn = button('复制卡密', {className: 'button button-secondary button-sm'}, 'copy');
    const statusMsg = el('div', {className: 'form-status'});

    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(view.secret, statusMsg);
      if (ok) {
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => { copyBtn.textContent = '复制卡密'; }, 2000);
      }
    });

    const secretBox = el('div', {style: 'background: var(--color-bg-subtle); padding: 0.75rem; border-radius: var(--radius-sm); margin-top: 0.5rem;'}, [
      el('div', {style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;'}, [
        el('strong', {text: '发货卡密 / 提取内容：'}),
        copyBtn,
      ]),
      el('pre', {style: 'margin: 0; white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.9rem;', text: view.secret}),
      statusMsg,
    ]);

    container.append(secretBox);

    if (view.leaveMessage) {
      container.append(
        el('div', {style: 'margin-top: 0.75rem;'}, [
          el('strong', {text: '商家留言：'}),
          renderRichText(view.leaveMessage),
        ])
      );
    }
  }

  if (initialKeyword) {
    doQuery();
  }
}
