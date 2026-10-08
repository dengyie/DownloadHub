import {getJSON,postJSON,safeURL} from '../api.js';
import {el,icon,link,button,banner,emptyState,loadingState,setBusy,money,renderRichText} from '../dom.js';
import {
  productIdFromURL, productOptions, initialSelection, quantityBounds, quantityError,
  contactField, isCustomer, normalizeWidgets, widgetErrors, buildQuoteFields,
  quoteKey, makeQuote, buildTradeFields, availablePayments, purchaseRestriction,
  checkoutReadiness,
} from '../commerce-model.js';

export async function renderProduct(root, {url, signal, sitePromise, navigate}) {
  const productId = productIdFromURL(url);
  if (!productId) {
    root.append(emptyState('商品不存在', '链接中的商品编号无效，请返回首页浏览其他资源。', link('返回资源广场', '/', {className: 'button button-primary'})));
    return;
  }

  root.append(el('div', {className: 'page-heading'}, [
    el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [link('资源广场', '/'), icon('chevron-right', 12), el('span', {text: '商品详情'})]),
  ]), loadingState('正在加载商品详情与实时库存…'));

  let productData;
  try {
    const res = await getJSON(`/user/api/index/commodityDetail?commodityId=${productId}`, {signal});
    productData = res.data;
  } catch (err) {
    if (signal.aborted) return;
    root.lastChild.remove();
    root.append(emptyState('无法加载商品', err.message || '商品可能已下架或暂停售卖。', link('返回资源广场', '/', {className: 'button button-primary'})));
    return;
  }
  if (signal.aborted) return;
  root.lastChild.remove();

  const product = productData;
  document.title = `${product.name} · MangoQWQ 资源站`;

  const site = (await sitePromise) || {};
  const loggedIn = isCustomer(site, site.user);
  const options = productOptions(product);
  let selection = initialSelection(product);
  const widgets = normalizeWidgets(product.widget);

  const values = {
    pay_id: 0,
    contact: loggedIn ? (site.user?.email || site.user?.username || '') : '',
    password: '',
    captcha: '',
    widget: {},
  };

  let quote = null;
  let quoteInFlight = false;
  let quoteError = '';
  let payments = [];

  try {
    const payRes = await getJSON('/user/api/index/pay', {signal});
    payments = availablePayments(Array.isArray(payRes.data) ? payRes.data : [], loggedIn);
    if (payments.length > 0) values.pay_id = payments[0].id;
  } catch {
    payments = [];
  }

  const mainPanel = el('section', {className: 'content-panel', style: 'flex: 2;'});
  const buyPanel = el('aside', {className: 'content-panel download-panel', style: 'flex: 1.2;'});
  const layout = el('div', {className: 'page-layout'}, [mainPanel, buyPanel]);
  root.append(layout);

  // Left Content: Title, Cover, Details
  const titleHead = el('div', {style: 'margin-bottom: 1.25rem;'}, [
    el('span', {className: 'badge badge-card', style: 'margin-bottom: 0.5rem; display: inline-block;', text: product.category?.name || '卡密资源'}),
    el('h1', {text: product.name, style: 'margin: 0; font-size: 1.5rem;'}),
  ]);
  mainPanel.append(titleHead);

  if (product.cover) {
    const safeCover = safeURL(product.cover);
    if (safeCover) {
      mainPanel.append(el('img', {src: safeCover, alt: product.name, style: 'max-width: 100%; border-radius: var(--radius-md); margin-bottom: 1.25rem;', loading: 'lazy'}));
    }
  }

  if (product.description) {
    mainPanel.append(el('h2', {className: 'section-title', text: '商品介绍'}), renderRichText(product.description));
  }

  // Right Purchase Form Elements
  const priceDisplay = el('div', {className: 'product-price', style: 'font-size: 1.5rem; font-weight: 700; color: var(--color-primary); margin-bottom: 1rem;'});
  const stockDisplay = el('div', {style: 'font-size: 0.9rem; color: var(--color-text-muted); margin-bottom: 1rem;'});
  const restrictionBanner = el('div', {className: 'form-status'});
  const optionsBox = el('div', {className: 'options-box'});
  const fieldsBox = el('div', {className: 'fields-box'});
  const submitBtn = button('立即购买', {className: 'button button-primary button-wide'}, 'lock');
  const actionStatus = el('div', {className: 'form-status', style: 'margin-top: 0.75rem;'});

  buyPanel.append(
    el('h2', {text: '选购与配置'}),
    priceDisplay,
    stockDisplay,
    restrictionBanner,
    optionsBox,
    fieldsBox,
    submitBtn,
    actionStatus
  );

  async function updateQuote() {
    quoteInFlight = true;
    quoteError = '';
    renderPurchaseState();
    try {
      const qFields = buildQuoteFields(product, selection);
      const valRes = await postJSON('/user/api/index/valuation', qFields, {signal});
      let stockData = {stock: product.inventory, stock_state: product.stock_state};
      try {
        const sRes = await postJSON('/user/api/index/stock', qFields, {signal});
        if (sRes?.data) stockData = sRes.data;
      } catch {}
      quote = makeQuote(product, selection, valRes.data || valRes, stockData);
    } catch (err) {
      if (signal.aborted) return;
      quote = null;
      quoteError = err.message || '获取报价失败';
    } finally {
      quoteInFlight = false;
      renderPurchaseState();
    }
  }

  function renderPurchaseState() {
    const restriction = purchaseRestriction(product, {now: Date.now()});
    if (restriction.code) {
      restrictionBanner.replaceChildren(banner(restriction.code === 'sale-upcoming' ? '秒杀活动尚未开始' : '秒杀活动已结束或不可用', 'warning'));
    } else {
      restrictionBanner.replaceChildren();
    }

    if (quoteInFlight) {
      priceDisplay.textContent = '计算价格中…';
      stockDisplay.textContent = '查询库存中…';
    } else if (quote) {
      priceDisplay.textContent = money(quote.price);
      stockDisplay.textContent = `库存状态：${quote.stockState > 0 ? (typeof quote.stock === 'number' ? `剩余 ${quote.stock} 件` : '充足') : '已售罄'}`;
    } else if (quoteError) {
      priceDisplay.textContent = '价格获取失败';
      stockDisplay.textContent = quoteError;
    }

    const state = checkoutReadiness({
      product, selection, quote, payments, payId: values.pay_id, values, loggedIn,
      widgets, site, pending: quoteInFlight,
    });

    submitBtn.disabled = !state.ready;
    if (!state.ready) {
      submitBtn.title = state.message || '请完善配置信息';
    } else {
      submitBtn.title = '确认订单并提交';
    }
  }

  function renderOptions() {
    optionsBox.replaceChildren();

    // Race selection
    if (options.races.length > 0) {
      const raceGroup = el('div', {className: 'form-field'}, [
        el('label', {text: '版本类别'}),
        el('div', {style: 'display: flex; gap: 0.5rem; flex-wrap: wrap;'}, options.races.map(race => {
          const btn = button(race.name, {
            className: `button button-sm ${selection.race === race.name ? 'button-primary' : 'button-secondary'}`,
            onclick: () => { selection.race = race.name; updateQuote(); renderOptions(); },
          });
          return btn;
        })),
      ]);
      optionsBox.append(raceGroup);
    }

    // SKU selection
    if (options.skus.length > 0) {
      options.skus.forEach(skuGroup => {
        const groupEl = el('div', {className: 'form-field'}, [
          el('label', {text: skuGroup.name}),
          el('div', {style: 'display: flex; gap: 0.5rem; flex-wrap: wrap;'}, skuGroup.options.map(opt => {
            const isSelected = selection.sku?.[skuGroup.name] === opt.value;
            return button(opt.value, {
              className: `button button-sm ${isSelected ? 'button-primary' : 'button-secondary'}`,
              onclick: () => {
                selection.sku = {...(selection.sku || {}), [skuGroup.name]: opt.value};
                updateQuote();
                renderOptions();
              },
            });
          })),
        ]);
        optionsBox.append(groupEl);
      });
    }

    // Quantity selection
    const bounds = quantityBounds(product);
    const qtyInput = el('input', {
      type: 'number', min: bounds.min, max: bounds.max || 999, value: selection.num,
      style: 'width: 100px;',
      oninput: () => {
        const val = Number(qtyInput.value);
        selection.num = val;
        renderPurchaseState();
      },
      onchange: () => {
        if (!quantityError(product, selection.num)) updateQuote();
      },
    });
    const qtyField = el('div', {className: 'form-field'}, [
      el('label', {text: `购买数量 (${bounds.min} - ${bounds.max || '无限制'})`}),
      qtyInput,
    ]);
    optionsBox.append(qtyField);

    // Coupon
    if (product.coupon === 1) {
      const couponInput = el('input', {
        placeholder: '如有优惠券请填写', value: selection.coupon || '',
        onchange: () => { selection.coupon = couponInput.value.trim(); updateQuote(); },
      });
      optionsBox.append(el('div', {className: 'form-field'}, [el('label', {text: '优惠券代码'}), couponInput]));
    }
  }

  function renderFields() {
    fieldsBox.replaceChildren();

    // Contact
    if (!loggedIn) {
      const cField = contactField(product.contact_type);
      if (cField) {
        const contactInput = el('input', {
          type: cField.type, placeholder: `请输入${cField.label}`, value: values.contact,
          oninput: () => { values.contact = contactInput.value.trim(); renderPurchaseState(); },
        });
        fieldsBox.append(el('div', {className: 'form-field'}, [el('label', {text: cField.label}), contactInput]));
      }

      // Password if required
      if (product.password_status === 1) {
        const pwdInput = el('input', {
          type: 'password', placeholder: '设置查询密码（6位以上）', value: values.password,
          oninput: () => { values.password = pwdInput.value; renderPurchaseState(); },
        });
        fieldsBox.append(el('div', {className: 'form-field'}, [el('label', {text: '查询密码'}), pwdInput]));
      }
    }

    // Custom widgets
    if (widgets.fields.length > 0) {
      widgets.fields.forEach(f => {
        const label = `${f.cn || f.name}${f.required ? ' *' : ''}`;
        let input;
        if (f.type === 'select') {
          input = el('select', {
            onchange: () => { values.widget[f.name] = input.value; renderPurchaseState(); },
          }, [el('option', {value: '', text: '请选择…'}), ...(f.options || []).map(o => el('option', {value: o.value, text: o.label}))]);
        } else if (f.type === 'textarea') {
          input = el('textarea', {
            rows: 2, oninput: () => { values.widget[f.name] = input.value; renderPurchaseState(); },
          });
        } else {
          input = el('input', {
            type: f.type === 'number' ? 'number' : 'text',
            oninput: () => { values.widget[f.name] = input.value; renderPurchaseState(); },
          });
        }
        fieldsBox.append(el('div', {className: 'form-field'}, [el('label', {text: label}), input]));
      });
    }

    // Payment methods
    if (payments.length > 0) {
      const payEl = el('div', {className: 'form-field'}, [
        el('label', {text: '支付方式'}),
        el('div', {style: 'display: flex; gap: 0.5rem; flex-wrap: wrap;'}, payments.map(p => {
          return button(p.name, {
            className: `button button-sm ${values.pay_id === p.id ? 'button-primary' : 'button-secondary'}`,
            onclick: () => { values.pay_id = p.id; renderPurchaseState(); renderFields(); },
          });
        })),
      ]);
      fieldsBox.append(payEl);
    }
  }

  submitBtn.addEventListener('click', async () => {
    if (submitBtn.disabled) return;
    setBusy(submitBtn, true, '正在提交订单…');
    actionStatus.replaceChildren();

    try {
      const tradeFields = buildTradeFields(product, selection, values, widgets);
      const res = await postJSON('/user/api/order/trade', tradeFields, {signal});
      const order = res.data;
      if (order?.url) {
        const safePay = safeURL(order.url);
        if (safePay) {
          location.assign(safePay);
          return;
        }
      }
      if (order?.trade_no) {
        navigate(`/user/index/query?tradeNo=${order.trade_no}`);
      } else {
        actionStatus.replaceChildren(banner('订单已提交，请前往订单查询页面查看发货信息。', 'success'));
      }
    } catch (err) {
      if (signal.aborted) return;
      actionStatus.replaceChildren(banner(err.message || '下单失败，请稍后重试', 'error'));
    } finally {
      setBusy(submitBtn, false);
    }
  });

  renderOptions();
  renderFields();
  await updateQuote();
}
