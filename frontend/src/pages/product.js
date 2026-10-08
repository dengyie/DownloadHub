import {getJSON, postJSON, safeURL} from '../api.js';
import {
  el,
  icon,
  button,
  link,
  inputField,
  banner,
  loadingState,
  errorState,
  emptyState,
  money,
  copyText,
  renderRichText,
} from '../dom.js';
import {
  isEnabled,
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
  saleTime,
  tradeOutcome,
  tradeFailureNeedsLookup,
  orderQueryPath,
  orderPresentation,
  pagination,
} from '../commerce-model.js';

const mounts = new WeakMap();

export async function renderProduct(root, context) {
  if (context.signal?.aborted) return () => {};
  document.title = '商品详情 · MangoQWQ 资源站';
  mounts.get(root)?.();
  const page = el('div', {className: 'stack'});
  const lifetime = new AbortController();
  let stopped = false,
    loadVersion = 0,
    quoteVersion = 0,
    payVersion = 0,
    cardVersion = 0;
  let quoteController, payController, cardController, quoteTimer, saleTimer, cardDialog;
  const alive = () => !stopped && !context.signal?.aborted && root.contains(page);
  const href = (value) => safeURL(value, {base: context.url.href});
  const internalLink = (label, path, attrs = {}, name) => {
    const destination = href(path);
    return link(
      label,
      destination,
      {
        ...attrs,
        onclick: (event) => {
          if (
            !destination ||
            !alive() ||
            event.button > 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          context.navigate(path);
        },
      },
      name
    );
  };
  function cleanup() {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    quoteController?.abort();
    payController?.abort();
    cardController?.abort();
    clearTimeout(quoteTimer);
    clearTimeout(saleTimer);
    if (cardDialog?.open) cardDialog.close();
    context.signal?.removeEventListener('abort', cleanup);
    if (root.contains(page)) {
      for (const input of page.querySelectorAll('input, textarea')) input.value = '';
      page.replaceChildren();
    }
    if (mounts.get(root) === cleanup) mounts.delete(root);
  }
  mounts.set(root, cleanup);
  context.signal?.addEventListener('abort', cleanup, {once: true});
  root.replaceChildren(page);
  const productID = productIdFromURL(context.url);
  if (!productID) {
    page.append(
      emptyState(
        '找不到这个商品',
        '商品链接无效，请返回资源列表重新选择。',
        internalLink('返回首页', '/', {className: 'button button-secondary'}, 'arrow-left')
      )
    );
    return cleanup;
  }

  async function load() {
    const version = ++loadVersion;
    page.replaceChildren(loadingState('正在加载商品与购买选项'));
    try {
      const [response, site] = await Promise.all([
        getJSON(`/user/api/index/commodityDetail?commodityId=${encodeURIComponent(productID)}`, {
          signal: lifetime.signal,
        }),
        Promise.resolve(context.sitePromise).catch(() => null),
      ]);
      if (!alive() || version !== loadVersion) return;
      const product = response.data;
      if (!product || typeof product !== 'object' || Number(product.id) !== Number(productID))
        throw new Error('商品详情返回不完整，请重新加载。');
      document.title = `${String(product.name || '商品详情')} · MangoQWQ 资源站`;
      build(product, site);
    } catch (error) {
      if (alive() && version === loadVersion)
        page.replaceChildren(
          errorState(error, () => {
            void load();
          })
        );
    }
  }

  function build(product, site) {
    const loggedIn = isCustomer(product, site),
      options = productOptions(product),
      widgets = normalizeWidgets(product.widget);
    const bounds = quantityBounds(product);
    const state = {
      selection: initialSelection(product),
      quote: null,
      pending: false,
      payments: [],
      payId: 0,
      submitting: false,
      completed: false,
      uncertain: false,
    };
    let selectedCard = null,
      payPending = false,
      captchaVersion = 0,
      restrictionKey;
    let cardPage = 1,
      cardTotal = 0,
      cardPending = false,
      cardSearchValue = '';
    const widgetInputs = new Map();
    const availability = el('div');
    const selectionNotice = el('div');
    const tradeFeedback = el('div', {'aria-live': 'polite'});
    const result = el('section', {
      className: 'content-panel stack',
      hidden: true,
      tabindex: -1,
      'aria-label': '订单结果',
    });
    const price = el('div', {className: 'price', text: '正在核算', 'aria-live': 'polite'});
    const stockBadge = el('span', {className: 'badge', text: '正在确认库存'});
    const quoteFeedback = el('div');
    const payList = el('div', {className: 'payment-options'});
    const payFeedback = el('div');
    const readinessNote = el('p', {className: 'field-help', id: 'product-readiness', 'aria-live': 'polite'});
    const controls = el(
      'fieldset',
      {className: 'purchase-options stack'},
      el('legend', {className: 'section-title', text: '购买选项'})
    );
    const submit = button(
      '创建订单',
      {
        type: 'submit',
        className: 'button button-primary',
        disabled: true,
        'aria-describedby': 'product-readiness',
      },
      'lock'
    );
    const refreshQuote = button(
      '重新获取价格与库存',
      {className: 'button button-quiet', onclick: () => scheduleQuote(0)},
      'refresh'
    );
    const refreshPay = button(
      '重新加载支付方式',
      {
        className: 'button button-quiet',
        onclick: () => {
          void loadPayments();
        },
      },
      'refresh'
    );
    const form = el(
      'form',
      {
        className: 'product-form content-panel stack',
        method: 'post',
        action: '/user/api/order/trade',
        autocomplete: 'off',
        onsubmit: submitOrder,
      },
      [controls, tradeFeedback]
    );

    function copyAction(label, value, container) {
      return button(
        label,
        {
          className: 'button button-quiet',
          onclick: async () => {
            if (!alive()) return;
            const copied = await copyText(value, container);
            if (alive() && page.contains(container))
              copyNotice.textContent = copied ? '已复制。' : '请在文本框中手动复制。';
          },
        },
        'copy'
      );
    }
    const copyNotice = el('p', {className: 'field-help', role: 'status'});
    const supportURL = href(product.service_url) || href(site?.support_url);
    const cover = href(product.cover);
    const summary = el(
      'section',
      {className: 'product-summary content-panel stack', 'aria-label': '商品详情'},
      [
        cover
          ? el('img', {
              className: 'product-cover',
              src: cover,
              alt: String(product.name || '商品封面'),
              width: 160,
              height: 160,
              referrerpolicy: 'no-referrer',
            })
          : el('div', {className: 'product-cover empty-cover'}, icon('layers', 56)),
        el('div', {className: 'row'}, [
          el('span', {
            className: 'badge',
            text: Number(product.delivery_way) === 0 ? '自动发货' : '商家发货',
          }),
          stockBadge,
        ]),
        el('h2', {className: 'section-title', text: '商品介绍'}),
        product.description
          ? renderRichText(product.description)
          : el('p', {className: 'muted', text: '商家暂未填写商品介绍。'}),
      ]
    );
    const summaryActions = el('div', {className: 'stack'});
    const shareURL = href(product.share_url) || href(`/item/${product.id}`);
    if (shareURL) summaryActions.append(copyAction('复制商品链接', shareURL, summaryActions));
    if (supportURL)
      summaryActions.append(
        link(
          '联系商家',
          supportURL,
          {className: 'button button-secondary', target: '_blank', rel: 'noopener noreferrer'},
          'external-link'
        )
      );
    summary.append(summaryActions, copyNotice);

    function choiceGroup(label, choices, selected, choose, premiums = false) {
      const group = el('div', {className: 'form-field'}),
        buttons = [];
      group.append(el('p', {className: 'section-title', text: label}));
      const list = el('div', {className: 'sku-options', role: 'group', 'aria-label': label});
      for (const choice of choices) {
        const extra = Number(choice.price);
        const caption = premiums
          ? `${choice.value}${extra > 0 ? ` +${money(extra)}` : ''}`
          : `${choice.value} · ${money(choice.price)}`;
        const option = button(caption, {
          className: `button button-secondary${choice.value === selected ? ' selected' : ''}`,
          'aria-pressed': String(choice.value === selected),
          onclick: () => {
            if (!alive() || state.submitting || state.completed) return;
            choose(choice.value);
            for (const [node, value] of buttons) {
              node.classList.toggle('selected', value === choice.value);
              node.setAttribute('aria-pressed', String(value === choice.value));
            }
            resetSelectedCard('商品规格已更改，自选卡已取消，请重新选择。');
            updateWholesale();
            scheduleQuote();
          },
        });
        buttons.push([option, choice.value]);
        list.append(option);
      }
      group.append(list);
      return group;
    }
    if (options.races.length)
      controls.append(
        choiceGroup('商品类型', options.races, state.selection.race, (value) => {
          state.selection.race = value;
        })
      );
    for (const group of options.skus)
      controls.append(
        choiceGroup(
          group.name,
          group.options,
          state.selection.sku[group.name],
          (value) => {
            state.selection.sku[group.name] = value;
          },
          true
        )
      );
    if (options.error) controls.append(banner(options.error, 'error'));

    const quantity = inputField('购买数量', 'num', {
      id: 'product-num',
      type: 'number',
      min: bounds.min,
      max: bounds.max,
      step: 1,
      required: true,
      value: state.selection.num,
      inputmode: 'numeric',
      'aria-describedby': 'product-quantity-help',
    });
    const stepQuantity = (delta) => {
      if (!alive() || state.submitting || state.completed) return;
      const current = Number(quantity.input.value);
      quantity.input.value = Math.min(
        bounds.max ?? Number.MAX_SAFE_INTEGER,
        Math.max(bounds.min, (Number.isSafeInteger(current) ? current : bounds.min) + delta)
      );
      syncSelection();
    };
    const quantityRow = el('div', {className: 'quantity-control'}, [
      button(
        '',
        {className: 'button button-secondary', 'aria-label': '减少购买数量', onclick: () => stepQuantity(-1)},
        'minus'
      ),
      quantity.input,
      button(
        '',
        {className: 'button button-secondary', 'aria-label': '增加购买数量', onclick: () => stepQuantity(1)},
        'plus'
      ),
    ]);
    quantity.field.append(
      quantityRow,
      el('p', {
        className: 'field-help',
        id: 'product-quantity-help',
        text: `至少 ${bounds.min} 件${bounds.max !== null ? `，每次最多 ${bounds.max} 件` : ''}。`,
      })
    );
    const wholesale = el('div');
    controls.append(quantity.field, wholesale);

    const cardLabel = el('p', {className: 'field-help', text: '未自选，将随机发货。'});
    const chooseCard = button(
      '选择卡片',
      {className: 'button button-secondary', onclick: openCards},
      'layers'
    );
    const clearCard = button(
      '取消自选',
      {
        className: 'button button-quiet',
        hidden: true,
        onclick: () => {
          resetSelectedCard('已取消自选，将随机发货。');
          scheduleQuote(0);
        },
      },
      'x'
    );
    if (isEnabled(product.draft_status))
      controls.append(
        el('section', {className: 'stack', 'aria-label': '自选卡片'}, [
          el('h2', {className: 'section-title', text: '自选卡片'}),
          el('div', {className: 'row'}, [chooseCard, clearCard]),
          cardLabel,
          el('p', {
            className: 'field-help',
            text: '自选卡仅支持购买 1 件；更改规格或数量后需重新选择。卡片可能另收自选费用，以核算价格为准。',
          }),
          selectionNotice,
        ])
      );

    const contact = contactField(product.contact_type);
    let contactInput, passwordInput, couponInput, captchaInput, captchaImage;
    const customerFields = el('div', {className: 'form-grid'});
    if (!loggedIn && contact) {
      const field = inputField(contact.label, 'contact', {
        id: 'product-contact',
        type: contact.type,
        autocomplete: 'off',
        inputmode: Number(product.contact_type) === 3 ? 'numeric' : undefined,
        minlength: 3,
        required: true,
        placeholder: `请输入${contact.label}`,
        'aria-describedby': 'product-contact-help',
      });
      contactInput = field.input;
      field.field.append(
        el('p', {
          className: 'field-help',
          id: 'product-contact-help',
          text: '请填写可用于之后查询订单的联系方式，并妥善保存订单号。',
        })
      );
      customerFields.append(field.field);
    } else if (loggedIn)
      controls.append(
        banner(
          site?.user?.username
            ? `已登录 ${site.user.username}，订单将关联当前账户。`
            : '已登录，订单将关联当前账户。'
        )
      );
    else controls.append(banner('该商品的联系方式类型暂不支持，请联系商家。', 'error'));
    if (isEnabled(product.password_status)) {
      const field = inputField(`查询密码${loggedIn ? '（选填）' : ''}`, 'password', {
        id: 'product-password',
        type: 'password',
        autocomplete: 'new-password',
        required: !loggedIn,
        minlength: 6,
        'aria-describedby': 'product-password-help',
      });
      passwordInput = field.input;
      field.field.append(
        el('p', {
          className: 'field-help',
          id: 'product-password-help',
          text: '至少 6 个字符。之后查看受保护的订单内容时需要此密码。',
        })
      );
      customerFields.append(field.field);
    }
    if (isEnabled(product.coupon)) {
      const field = inputField('优惠券（选填）', 'coupon', {
        id: 'product-coupon',
        type: 'text',
        autocomplete: 'off',
        placeholder: '输入优惠券后重新核算',
        'aria-describedby': 'product-coupon-help',
      });
      couponInput = field.input;
      field.field.append(
        el('p', {
          className: 'field-help',
          id: 'product-coupon-help',
          text: '优惠券适用范围与抵扣金额以服务器核算为准。',
        })
      );
      customerFields.append(field.field);
    }
    controls.append(customerFields);

    for (const [index, field] of widgets.fields.entries()) {
      const id = `product-widget-${index}`,
        label = `${field.label}${field.required ? '（必填）' : '（选填）'}`;
      const inputs = [],
        container = el('div', {className: 'form-field'});
      if (field.type === 'checkbox' || field.type === 'radio') {
        const group = el('fieldset', {className: 'stack'}, el('legend', {text: label}));
        const choices = el('div', {className: 'sku-options'});
        for (const [optionIndex, option] of field.options.entries()) {
          const input = el('input', {
            type: field.type,
            id: `${id}-${optionIndex}`,
            name: field.type === 'checkbox' ? `${field.name}[]` : field.name,
            value: option.value,
            checked: field.type === 'radio' && optionIndex === 0,
            required: field.type === 'radio' && field.required,
          });
          inputs.push(input);
          choices.append(
            el('label', {className: 'choice-option', for: input.id}, [
              input,
              el('span', {text: option.label}),
            ])
          );
        }
        group.append(choices);
        container.append(group);
      } else {
        const attrs = {
          id,
          name: field.name,
          required: field.required,
          autocomplete: 'off',
          placeholder: field.placeholder,
          'aria-describedby': `${id}-help`,
        };
        const input =
          field.type === 'select'
            ? el('select', attrs, [
                el('option', {value: '', text: field.placeholder || '请选择'}),
                field.options.map((option) => el('option', {value: option.value, text: option.label})),
              ])
            : field.type === 'textarea'
              ? el('textarea', {...attrs, rows: 3})
              : el('input', {...attrs, type: field.type, step: field.type === 'number' ? 'any' : undefined});
        inputs.push(input);
        container.append(el('label', {for: id, text: label}), input);
      }
      container.append(
        el('p', {
          className: 'field-help',
          id: `${id}-help`,
          text: field.serverValidation ? field.error || '填写格式会在提交时由商家校验。' : field.placeholder,
        })
      );
      widgetInputs.set(field.name, {
        field,
        inputs,
        read: () =>
          field.type === 'checkbox'
            ? inputs.filter((input) => input.checked).map((input) => input.value)
            : field.type === 'radio'
              ? (inputs.find((input) => input.checked)?.value ?? '')
              : inputs[0].value,
      });
      controls.append(container);
    }
    for (const message of widgets.unsupported) controls.append(banner(message, 'error'));

    if (isEnabled(product.trade_captcha)) {
      const field = inputField('图形验证码', 'captcha', {
        id: 'product-captcha',
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        required: true,
      });
      captchaInput = field.input;
      captchaImage = el('img', {alt: '下单图形验证码', width: 120, height: 40});
      field.field.append(
        el('div', {className: 'row'}, [
          captchaImage,
          button(
            '换一张验证码',
            {
              className: 'button button-quiet',
              onclick: () => {
                refreshCaptcha();
                updateReadiness();
              },
            },
            'refresh'
          ),
        ])
      );
      controls.append(field.field);
      refreshCaptcha();
    }
    controls.append(
      el('section', {className: 'price-panel stack', 'aria-label': '价格与支付'}, [
        el('h2', {className: 'section-title', text: '商品金额'}),
        price,
        el('p', {className: 'field-help', text: '金额由商家实时核算。支付渠道手续费以最终订单为准。'}),
        quoteFeedback,
        refreshQuote,
        el('h2', {className: 'section-title', text: '支付方式'}),
        payList,
        payFeedback,
        refreshPay,
        readinessNote,
        submit,
      ])
    );
    form.addEventListener('input', syncSelection);
    form.addEventListener('change', syncSelection);
    page.replaceChildren(
      el('header', {className: 'page-heading'}, [
        el('p', {className: 'eyebrow', text: '商品购买'}),
        el('h1', {text: String(product.name || '商品')}),
        el('p', {className: 'muted', text: '选择规格，确认金额后创建订单。'}),
      ]),
      availability,
      el('div', {className: 'product-layout'}, [summary, form]),
      result
    );

    function readValues() {
      return {
        pay_id: state.payId,
        contact: contactInput?.value ?? '',
        password: passwordInput?.value ?? '',
        captcha: captchaInput?.value ?? '',
        widget: Object.fromEntries([...widgetInputs].map(([name, entry]) => [name, entry.read()])),
      };
    }
    function readiness() {
      return checkoutReadiness({product, ...state, values: readValues(), widgets, loggedIn, site});
    }
    function updateReadiness() {
      if (!alive()) return;
      const status = readiness();
      controls.disabled = state.submitting || state.completed;
      submit.disabled = !status.ready;
      submit.setAttribute('aria-busy', String(state.submitting));
      const submitLabel = state.submitting
        ? '正在创建订单'
        : state.completed
          ? '订单已创建'
          : state.quote && !state.pending
            ? state.quote.price === 0
              ? '创建免费订单'
              : `创建订单并支付 ${money(state.quote.price)}`
            : '创建订单';
      // An input's change event fires between pointerdown and pointerup when
      // the customer clicks Submit. Keep its target node if the label is unchanged.
      if (submit.textContent !== submitLabel)
        submit.replaceChildren(
          icon(state.submitting ? 'loader' : 'lock', 18),
          el('span', {text: submitLabel})
        );
      readinessNote.textContent = status.message;
      refreshQuote.disabled = state.pending || state.submitting || state.completed;
      refreshPay.disabled = payPending || state.submitting || state.completed;
      chooseCard.disabled =
        Number(state.selection.num) !== 1 ||
        bounds.min > 1 ||
        Boolean(quantityError(product, state.selection.num)) ||
        state.submitting ||
        state.completed;
      clearCard.hidden = !selectedCard;
      quantity.input.setCustomValidity(quantityError(product, quantity.input.value));
      const errors = widgetErrors(widgets, readValues().widget);
      for (const [name, entry] of widgetInputs)
        entry.inputs[0]?.setCustomValidity(errors.find((error) => error.field === name)?.message ?? '');
      const restriction = purchaseRestriction(product, {site, loggedIn});
      const key = `${restriction.code}:${restriction.message}`;
      if (restrictionKey !== key) {
        restrictionKey = key;
        availability.replaceChildren();
        if (restriction.code) {
          availability.append(banner(restriction.message));
          if (restriction.code === 'login')
            availability.append(
              internalLink(
                '登录后购买',
                '/user/authentication/login',
                {className: 'button button-primary'},
                'lock'
              )
            );
        } else if (isEnabled(product.seckill_status))
          availability.append(banner(`限时抢购中，结束时间：${product.seckill_end_time}。`));
      }
      return status;
    }
    function syncSelection() {
      if (!alive() || state.submitting || state.completed) return;
      let changed = false;
      if (String(state.selection.num) !== quantity.input.value) {
        state.selection.num = quantity.input.value;
        changed = true;
        resetSelectedCard('购买数量已更改，自选卡已取消，将随机发货。');
      }
      if (state.selection.coupon !== (couponInput?.value ?? '')) {
        state.selection.coupon = couponInput?.value ?? '';
        changed = true;
      }
      if (changed) scheduleQuote();
      else updateReadiness();
    }
    function updateWholesale() {
      const config = product.config || {};
      const tiers = options.races.length
        ? config.category_wholesale?.[state.selection.race]
        : config.wholesale;
      const rows = Object.entries(tiers && typeof tiers === 'object' ? tiers : {})
        .filter(([num, amount]) => Number(num) > 0 && Number.isFinite(Number(amount)))
        .sort(([a], [b]) => Number(a) - Number(b));
      wholesale.replaceChildren();
      if (rows.length) {
        const head = el(
          'thead',
          {},
          el('tr', {}, [
            el('th', {scope: 'col', text: '起购数量'}),
            el('th', {scope: 'col', text: '参考单价'}),
          ])
        );
        const body = el(
          'tbody',
          {},
          rows.map(([num, amount]) => el('tr', {}, [el('td', {text: num}), el('td', {text: money(amount)})]))
        );
        wholesale.append(
          el('details', {}, [
            el('summary', {text: '批量购买价格'}),
            el('table', {}, [head, body]),
            el('p', {className: 'field-help', text: '规格附加费用与最终优惠以实时核算金额为准。'}),
          ])
        );
      }
    }

    function scheduleQuote(delay = 180) {
      if (!alive() || state.submitting || state.completed) return;
      clearTimeout(quoteTimer);
      quoteController?.abort();
      const version = ++quoteVersion;
      state.quote = null;
      state.pending = true;
      quoteFeedback.replaceChildren();
      price.textContent = '正在核算';
      stockBadge.textContent = '正在确认库存';
      const error = options.error || quantityError(product, state.selection.num);
      if (error) {
        state.pending = false;
        price.textContent = '等待有效购买选项';
        stockBadge.textContent = '库存尚未确认';
        quoteFeedback.append(banner(error, 'error'));
        updateReadiness();
        return;
      }
      updateReadiness();
      quoteTimer = setTimeout(() => {
        void loadQuote(version);
      }, delay);
    }
    async function loadQuote(version) {
      if (!alive() || version !== quoteVersion) return;
      const controller = new AbortController();
      quoteController = controller;
      const fields = buildQuoteFields(product, state.selection),
        key = quoteKey(product, state.selection);
      try {
        const [valuation, stock] = await Promise.all([
          postJSON('/user/api/index/valuation', fields, {signal: controller.signal}),
          postJSON('/user/api/index/stock', fields, {signal: controller.signal}),
        ]);
        if (!alive() || version !== quoteVersion || key !== quoteKey(product, state.selection)) return;
        state.quote = makeQuote(product, state.selection, valuation.data, stock.data);
        price.textContent = money(state.quote.price);
        stockBadge.textContent =
          state.quote.stockState > 0 ? `库存 ${state.quote.stock || '有货'}` : '已售罄';
      } catch (error) {
        controller.abort();
        if (!alive() || version !== quoteVersion) return;
        state.quote = null;
        price.textContent = '价格尚未确认';
        stockBadge.textContent = '库存尚未确认';
        quoteFeedback.replaceChildren(banner(error.message || '获取价格与库存失败，请重试。', 'error'));
      } finally {
        if (alive() && version === quoteVersion) {
          state.pending = false;
          updateReadiness();
        }
      }
    }
    async function loadPayments() {
      if (!alive() || state.submitting || state.completed) return;
      payController?.abort();
      const controller = new AbortController();
      payController = controller;
      const version = ++payVersion;
      payPending = true;
      state.payments = [];
      payList.replaceChildren(loadingState('正在加载支付方式'));
      payFeedback.replaceChildren();
      updateReadiness();
      try {
        const response = await getJSON(`/user/api/index/pay?itemId=${encodeURIComponent(product.id)}`, {
          signal: controller.signal,
        });
        if (!alive() || version !== payVersion) return;
        if (!Array.isArray(response.data)) throw new Error('支付方式数据无效，请重试。');
        state.payments = availablePayments(response.data, loggedIn);
        if (!state.payments.some((pay) => pay.id === state.payId)) state.payId = state.payments[0]?.id ?? 0;
        payList.replaceChildren(
          ...state.payments.map((pay) => {
            const input = el('input', {
              type: 'radio',
              name: 'pay_id',
              value: pay.id,
              checked: pay.id === state.payId,
              onchange: () => {
                if (input.checked) {
                  state.payId = pay.id;
                  updateReadiness();
                }
              },
            });
            return el('label', {className: 'payment-option'}, [
              input,
              icon(pay.handle === '#system' ? 'lock' : 'external-link', 18),
              el('span', {text: pay.name}),
            ]);
          })
        );
        if (!state.payments.length)
          payFeedback.append(banner('当前没有可用的支付方式，请稍后重试或联系商家。'));
      } catch (error) {
        if (alive() && version === payVersion) {
          payList.replaceChildren();
          payFeedback.replaceChildren(banner(error.message || '支付方式加载失败。', 'error'));
        }
      } finally {
        if (alive() && version === payVersion) {
          payPending = false;
          updateReadiness();
        }
      }
    }
    function refreshCaptcha() {
      if (!captchaImage) return;
      captchaImage.src = href(`/user/captcha/image?action=trade&_t=${Date.now()}&v=${++captchaVersion}`);
      captchaInput.value = '';
    }
    function scheduleSale() {
      clearTimeout(saleTimer);
      if (!isEnabled(product.seckill_status) || !alive()) return;
      const now = Date.now(),
        start = saleTime(product.seckill_start_time),
        next = [start, saleTime(product.seckill_end_time)]
          .filter((time) => time > now)
          .sort((a, b) => a - b)[0];
      if (next)
        saleTimer = setTimeout(
          () => {
            if (!alive()) return;
            if (now < start && !purchaseRestriction(product, {site, loggedIn}).code) scheduleQuote(0);
            else updateReadiness();
            scheduleSale();
          },
          Math.min(2147483647, next - now + 25)
        );
    }

    function closeCards() {
      ++cardVersion;
      cardController?.abort();
      cardPending = false;
      if (cardDialog?.open) cardDialog.close();
    }
    function resetSelectedCard(message) {
      closeCards();
      if (selectedCard) selectionNotice.replaceChildren(banner(message));
      selectedCard = null;
      state.selection.card_id = 0;
      cardLabel.textContent = '未自选，将随机发货。';
      clearCard.hidden = true;
    }
    function openCards() {
      if (!alive() || chooseCard.disabled || state.submitting || state.completed) return;
      if (!cardDialog) {
        cardDialog = el('dialog', {className: 'dialog', 'aria-labelledby': 'product-card-title'});
        cardDialog.addEventListener('close', () => {
          ++cardVersion;
          cardController?.abort();
          cardPending = false;
          if (alive()) chooseCard.focus();
        });
        page.append(cardDialog);
      }
      cardPage = 1;
      cardTotal = 0;
      cardSearchValue = '';
      const search = inputField('搜索卡片预览', 'search-draft', {
        id: 'product-card-search',
        type: 'search',
        autocomplete: 'off',
      });
      const feedback = el('div', {'aria-live': 'polite'}),
        list = el('div', {className: 'stack'}),
        pages = el('nav', {className: 'pagination', 'aria-label': '卡片分页'});
      const searchButton = button('搜索', {type: 'submit', className: 'button button-secondary'}, 'search');
      const searchForm = el(
        'form',
        {
          method: 'post',
          action: '/user/api/index/card',
          onsubmit: (event) => {
            event.preventDefault();
            cardSearchValue = search.input.value.trim();
            void loadCards(1);
          },
        },
        [search.field, searchButton]
      );
      cardDialog.replaceChildren(
        el('div', {className: 'stack'}, [
          el('h2', {id: 'product-card-title', text: '选择卡片'}),
          el('p', {className: 'muted', text: '这里只展示卡片预览，选择后会重新核算总价。'}),
          searchForm,
          feedback,
          list,
          pages,
          button('关闭', {className: 'button button-quiet', onclick: closeCards}, 'x'),
        ])
      );
      cardDialog.showModal();
      void loadCards(1);

      function drawPages() {
        const model = pagination(cardTotal, cardPage, 10);
        pages.replaceChildren(
          button(
            '上一页',
            {
              className: 'button button-secondary',
              disabled: cardPending || model.previous === null,
              onclick: () => {
                if (model.previous) void loadCards(model.previous);
              },
            },
            'chevron-left'
          ),
          el('span', {text: `第 ${model.page} 页 / 共 ${model.pages} 页，${model.total} 张`}),
          button(
            '下一页',
            {
              className: 'button button-secondary',
              disabled: cardPending || model.next === null,
              onclick: () => {
                if (model.next) void loadCards(model.next);
              },
            },
            'chevron-right'
          )
        );
      }
      async function loadCards(requestedPage) {
        if (!alive() || !cardDialog.open || Number(state.selection.num) !== 1) return;
        cardController?.abort();
        const controller = new AbortController();
        cardController = controller;
        const version = ++cardVersion;
        cardPending = true;
        searchButton.disabled = true;
        feedback.replaceChildren(loadingState('正在加载可选卡片'));
        drawPages();
        try {
          const fields = buildQuoteFields(product, state.selection);
          const response = await postJSON(
            '/user/api/index/card',
            {
              item_id: product.id,
              race: fields.race,
              sku: fields.sku,
              page: requestedPage,
              limit: 10,
              'search-draft': cardSearchValue,
            },
            {signal: controller.signal}
          );
          if (!alive() || version !== cardVersion || !cardDialog.open) return;
          const data = response.data;
          if (
            !Array.isArray(data?.list) ||
            data.list.some((card) => !Number.isSafeInteger(Number(card?.id)) || Number(card.id) < 1)
          )
            throw new Error('卡片列表数据无效，请重试。');
          pagination(data.total, requestedPage, 10);
          cardPage = requestedPage;
          cardTotal = Number(data.total);
          feedback.replaceChildren();
          list.replaceChildren(
            ...data.list.map((card) => {
              const premium = Number(card.draft_premium) > 0 ? card.draft_premium : product.draft_premium;
              return el('article', {className: 'content-panel stack'}, [
                el('p', {text: String(card.draft || `卡片 ${card.id}`)}),
                el('p', {
                  className: 'field-help',
                  text: Number(premium) > 0 ? `自选附加费用 ${money(premium)}` : '无自选附加费用',
                }),
                button(
                  '选择此卡',
                  {
                    className: 'button button-secondary',
                    onclick: () => {
                      if (
                        !alive() ||
                        version !== cardVersion ||
                        state.submitting ||
                        state.completed ||
                        Number(state.selection.num) !== 1
                      )
                        return;
                      selectedCard = card;
                      state.selection.card_id = Number(card.id);
                      cardLabel.textContent = `已选择：${String(card.draft || card.id)}${Number(premium) > 0 ? `（附加 ${money(premium)}）` : ''}`;
                      selectionNotice.replaceChildren();
                      closeCards();
                      scheduleQuote(0);
                    },
                  },
                  'check'
                ),
              ]);
            })
          );
          if (!data.list.length)
            list.append(emptyState('没有可选卡片', '可以修改搜索内容，或关闭窗口使用随机发货。'));
        } catch (error) {
          if (alive() && version === cardVersion && cardDialog.open)
            feedback.replaceChildren(
              banner(error.message || '可选卡片加载失败。', 'error'),
              button(
                '重新加载卡片',
                {
                  className: 'button button-secondary',
                  onclick: () => {
                    void loadCards(requestedPage);
                  },
                },
                'refresh'
              )
            );
        } finally {
          if (alive() && version === cardVersion && cardDialog.open) {
            cardPending = false;
            searchButton.disabled = false;
            drawPages();
          }
        }
      }
    }

    async function submitOrder(event) {
      event.preventDefault();
      if (!alive() || state.submitting || state.completed || state.uncertain) return;
      syncSelection();
      const status = updateReadiness();
      if (!status?.ready) {
        tradeFeedback.replaceChildren(banner(status?.message || '请先确认购买选项。', 'error'));
        return;
      }
      if (!form.reportValidity()) return;
      const payment = state.payments.find((pay) => pay.id === state.payId);
      const fields = buildTradeFields(product, state.selection, readValues(), widgets);
      state.submitting = true;
      closeCards();
      updateReadiness();
      tradeFeedback.replaceChildren(loadingState('正在创建订单，请勿重复提交'));
      try {
        // A trade is issued once per explicit submit. Never retry a lost response.
        const response = await postJSON('/user/api/order/trade', fields, {signal: lifetime.signal});
        if (!alive()) return;
        const outcome = tradeOutcome(response.data, payment);
        state.completed = true;
        if (passwordInput) passwordInput.value = '';
        if (captchaInput) captchaInput.value = '';
        for (const entry of widgetInputs.values())
          if (entry.field.type === 'password') entry.inputs[0].value = '';
        showResult(outcome);
        tradeFeedback.replaceChildren();
      } catch (error) {
        if (!alive()) return;
        state.quote = null;
        state.pending = false;
        ++quoteVersion;
        quoteController?.abort();
        clearTimeout(quoteTimer);
        price.textContent = '请重新确认价格';
        stockBadge.textContent = '库存尚未确认';
        state.uncertain = tradeFailureNeedsLookup(error);
        refreshCaptcha();
        const message = state.uncertain
          ? '没有收到明确的下单结果。请先用订单号或联系方式查询，确认后再决定是否重新下单。'
          : error.message || '下单失败，请检查信息后重新获取价格与库存。';
        tradeFeedback.replaceChildren(
          banner(message, 'error'),
          internalLink('查询订单', '/user/index/query', {className: 'button button-secondary'}, 'search')
        );
        if (state.uncertain)
          tradeFeedback.append(
            button(
              '已核对订单，重新准备下单',
              {
                className: 'button button-quiet',
                onclick: () => {
                  if (!alive() || state.submitting || state.completed) return;
                  state.uncertain = false;
                  tradeFeedback.replaceChildren();
                  scheduleQuote(0);
                },
              },
              'refresh'
            )
          );
      } finally {
        if (alive()) {
          state.submitting = false;
          updateReadiness();
        }
      }
    }
    function showResult(outcome) {
      const {tradeNo, paid, amount, secret, paymentURL} = outcome;
      const view = orderPresentation({
        status: paid ? 1 : 0,
        delivery_status: paid && Number(product.delivery_way) === 0 && secret.trim() ? 1 : 0,
        password: false,
        secret,
        commodity: {delivery_way: product.delivery_way},
      });
      const actions = el('div', {className: 'row'});
      result.hidden = false;
      result.replaceChildren(
        el('h2', {className: 'section-title', text: '订单已创建'}),
        el('p', {text: `订单号：${tradeNo}`}),
        el('p', {
          text: `${amount !== null ? '订单金额' : '商品金额'}：${money(amount ?? state.quote.price)}`,
        }),
        banner(paid ? view.message : '请保存订单号，再继续前往支付页面。支付完成后可查询发货内容。'),
        actions
      );
      actions.append(
        copyAction('复制订单号', tradeNo, result),
        internalLink('查看订单', orderQueryPath(tradeNo), {className: 'button button-secondary'}, 'search')
      );
      if (paid && view.secret) {
        const content = el('section', {className: 'stack'}, [
          el('h3', {className: 'section-title', text: view.kind === 'manual' ? '商家发货说明' : '发货内容'}),
          el('pre', {className: 'order-secret', tabindex: 0, text: view.secret}),
        ]);
        content.append(copyAction('复制发货内容', view.secret, content));
        result.append(content);
      }
      if (!paid) {
        const safePaymentURL = href(paymentURL);
        if (safePaymentURL)
          actions.append(
            link(
              '继续支付',
              safePaymentURL,
              {className: 'button button-primary', rel: 'noreferrer'},
              'external-link'
            )
          );
        else
          result.append(
            banner('订单已创建，但支付地址无效。请查询订单或联系商家处理，避免重复下单。', 'error')
          );
      }
      result.focus();
    }
    updateWholesale();
    updateReadiness();
    scheduleSale();
    scheduleQuote(0);
    void loadPayments();
  }

  void load();
  return cleanup;
}
