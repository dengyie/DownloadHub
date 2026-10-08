import {postJSON, grantSession} from '../api.js';
import {el, icon, link, button, banner, inputField, setBusy, copyText} from '../dom.js';
import {legacyRedemption, redemptionResult, grantExpired} from '../redemption-model.js';

export async function renderRedeem(root, {url, signal}) {
  document.title = '卡密兑换 · MangoQWQ 资源站';
  const card = inputField('卡号', 'card', {
    required: true,
    maxlength: 128,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '输入你收到的卡号',
  });
  const key = inputField('密钥', 'key', {
    type: 'password',
    required: true,
    maxlength: 256,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '输入与卡号对应的密钥',
  });
  const reveal = button('', {'aria-label': '显示密钥', 'aria-pressed': 'false'}, 'eye');
  reveal.addEventListener('click', () => {
    const visible = key.input.type === 'password';
    key.input.type = visible ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(visible));
    reveal.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
  });
  key.field.append(el('div', {className: 'password-input'}, [key.input, reveal]));
  const resource = inputField('资源路径', 'resource', {
    maxlength: 2048,
    autocomplete: 'off',
    placeholder: '例如 private/toolkit.zip',
  });
  resource.field.append(
    el('small', {className: 'field-help', text: '仅旧版前缀卡需要填写，路径必须在该卡授权范围内。'})
  );
  const legacy = el('details', {className: 'legacy-resource'}, [
    el('summary', {text: '使用旧版卡密或指定资源路径'}),
    resource.field,
  ]);
  const status = el('div', {className: 'form-status'});
  const results = el('div', {className: 'redeem-results', 'aria-label': '可用资源'});
  const submit = button(
    '查看可用资源',
    {type: 'submit', className: 'button button-primary button-wide'},
    'arrow-right'
  );
  const form = el('form', {id: 'redeem-form'}, [card.field, key.field, legacy, submit, status]);
  const intro = el('section', {className: 'redeem-intro'}, [
    el('p', {className: 'eyebrow', text: 'A LITTLE KEY, MORE POSSIBILITIES'}),
    el('h1', {}, ['你的专属资源，', el('br'), el('em', {text: '即刻解锁。'})]),
    el('p', {
      text: '准备好卡号和密钥，让好用的资源来到你身边。查看资源不会扣减次数，由你确认后再签发下载授权。',
    }),
    el(
      'ol',
      {className: 'steps'},
      [
        ['01', '输入卡号与密钥', '可从购买记录或资源提供方处获取。'],
        ['02', '确认要下载的资源', '查看清单不会消耗下载次数。'],
        ['03', '签发授权并下载', '保留本页，可恢复同一有效授权。'],
      ].map(([number, title, detail]) =>
        el('li', {}, [
          el('span', {className: 'step-number', text: number}),
          el('div', {}, [el('h3', {text: title}), el('p', {text: detail})]),
        ])
      )
    ),
    link('遇到问题？查看兑换指南', '/help#redeem', {className: 'text-link'}, 'arrow-right'),
  ]);
  root.append(
    el(
      'div',
      {className: 'page-heading'},
      el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [
        link('资源广场', '/'),
        icon('chevron-right', 12),
        el('span', {text: '卡密兑换'}),
      ])
    ),
    el('div', {className: 'redeem-layout'}, [
      intro,
      el('section', {className: 'content-panel'}, [
        el('div', {className: 'redeem-form-head'}, [
          el('div', {className: 'resource-icon'}, icon('lock', 20)),
          el('div', {}, [
            el('h2', {text: '兑换你的资源'}),
            el('p', {text: '卡号和密钥仅用于本次校验，不写入浏览器存储。'}),
          ]),
        ]),
        form,
        results,
        el('p', {
          className: 'redemption-footnote',
          text: '链接有时效，请勿分享卡密或下载授权。\n已购买但找不到卡密？可前往订单查询。',
        }),
        link('查找我的订单', '/user/index/query', {className: 'button button-quiet button-wide'}, 'search'),
      ]),
    ])
  );

  let expireChecks = [];
  let checkingCard = false;
  let grantButtons = [];
  const pendingGrants = new Set();
  // Replacing the resource list must not discard an in-flight credential: the
  // server may already have consumed quota even if its response is still pending.
  function syncActions() {
    submit.disabled = checkingCard || pendingGrants.size > 0;
    for (const download of grantButtons) download.disabled = checkingCard || pendingGrants.has(download);
  }
  function renderResults(data) {
    const quota = el('p', {
      className: 'quota-summary',
      role: 'status',
      text: Number.isFinite(data.quota)
        ? `剩余 ${data.quota} 次下载授权 · 查看资源不扣次`
        : '请确认资源，再签发或恢复已有授权。',
    });
    const checks = [];
    const buttons = [];
    const entries = data.resources.map((item) => {
      let grant;
      const issue = grantSession(item.credential);
      const message = el('p', {className: 'grant-status', role: 'status'});
      const fallback = el('div');
      const open = link(
        '打开下载链接',
        '#',
        {
          className: 'button button-primary button-small grant-open',
          hidden: true,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'external-link'
      );
      const download = button('签发下载授权', {className: 'button button-small'}, 'lock');
      buttons.push(download);
      const copy = button('复制链接', {className: 'button button-small', disabled: true}, 'copy');
      function expire() {
        if (!grant || !grantExpired(grant)) return false;
        grant = undefined;
        open.hidden = true;
        open.removeAttribute('href');
        copy.disabled = true;
        fallback.replaceChildren();
        message.classList.add('error');
        message.textContent = '下载授权已过期。请重新查看资源，新授权会按剩余次数签发。';
        return true;
      }
      checks.push(expire);
      download.addEventListener('click', async () => {
        if (checkingCard || pendingGrants.has(download)) return;
        pendingGrants.add(download);
        setBusy(download, true, '正在核验授权');
        syncActions();
        open.hidden = true;
        copy.disabled = true;
        fallback.replaceChildren();
        message.classList.remove('error');
        message.textContent = '首次签发会扣减一次；同一凭证重试会恢复已有授权。';
        try {
          const next = await issue({signal});
          if (signal.aborted) return;
          grant = next;
          if (Number.isFinite(grant.quota)) quota.textContent = `剩余 ${grant.quota} 次下载授权`;
          open.href = grant.url;
          open.hidden = false;
          copy.disabled = false;
          message.textContent = `有效至 ${new Date(grant.expires_at).toLocaleString('zh-CN')}。请点击下方链接下载，本页保留恢复入口。`;
        } catch (error) {
          if (signal.aborted) return;
          grant = undefined;
          message.classList.add('error');
          message.textContent = `${error.message}。可用下方恢复按钮重试同一凭证。`;
        } finally {
          pendingGrants.delete(download);
          if (!signal.aborted) {
            setBusy(download, false, '核验并恢复链接');
            syncActions();
          }
        }
      });
      open.addEventListener('click', (event) => {
        if (expire() || !grant) event.preventDefault();
      });
      copy.addEventListener('click', async () => {
        if (copy.disabled || expire() || !grant) return;
        const copied = await copyText(grant.url, fallback);
        if (!signal.aborted)
          message.textContent = copied
            ? '链接已复制。请在有效期内使用，并妥善保管。'
            : '自动复制不可用，链接已选中，请手动复制。';
      });
      return el('article', {className: 'grant-card'}, [
        el('div', {className: 'grant-title'}, [icon('paperclip', 18), el('span', {text: item.name})]),
        el('div', {className: 'grant-actions'}, [download, copy]),
        message,
        open,
        fallback,
      ]);
    });
    expireChecks = checks;
    grantButtons = buttons;
    syncActions();
    results.replaceChildren(
      el('div', {className: 'section-title'}, el('h2', {text: '可用资源'})),
      quota,
      ...entries
    );
    if (!entries.length)
      results.append(
        banner('这张卡使用旧版路径授权。请展开“使用旧版卡密或指定资源路径”，填写提供方给出的完整资源路径。')
      );
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (checkingCard || pendingGrants.size > 0) return;
    if (!card.input.value.trim() || !key.input.value.trim()) {
      status.replaceChildren(banner('请填写卡号和密钥。', 'error'));
      return;
    }
    checkingCard = true;
    setBusy(submit, true, '正在校验卡密');
    syncActions();
    status.replaceChildren();
    try {
      const data = redemptionResult(
        await postJSON(
          '/api/redeem',
          {card: card.input.value.trim(), key: key.input.value.trim(), resource: resource.input.value.trim()},
          {signal}
        )
      );
      if (!signal.aborted) renderResults(data);
    } catch (error) {
      if (!signal.aborted)
        status.replaceChildren(
          banner(
            error.message + (results.childNodes.length ? ' 已有资源与恢复凭证仍保留在下方。' : ''),
            'error'
          )
        );
    } finally {
      checkingCard = false;
      if (!signal.aborted) {
        setBusy(submit, false, '查看可用资源');
        syncActions();
      }
    }
  });
  if (url.pathname.startsWith('/dl/')) {
    try {
      const data = legacyRedemption(url);
      if (data.resources) renderResults(data);
      else {
        card.input.value = data.card;
        key.input.value = data.key;
        resource.input.value = data.resource;
        legacy.open = true;
      }
      status.replaceChildren(banner('已读取旧链接，请手动确认后继续。打开此页面不会扣次。'));
    } catch (error) {
      status.replaceChildren(banner(error.message, 'error'));
    } finally {
      history.replaceState(null, '', '/redeem');
    }
  }
  const timer = setInterval(() => expireChecks.forEach((check) => check()), 1000);
  const cleanup = () => {
    clearInterval(timer);
    expireChecks = [];
    key.input.value = '';
    card.input.value = '';
  };
  signal.addEventListener('abort', cleanup, {once: true});
  return cleanup;
}
