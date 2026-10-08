import {safeURL} from '../api.js';
import {el, icon, link, banner, loadingState, errorState, money} from '../dom.js';

export async function renderAccount(root, {url, signal, navigate, sitePromise, refreshSite}) {
  document.title = '我的账户 · MangoQWQ 资源站';
  root.append(loadingState('正在加载账户信息'));
  const site = await sitePromise;
  if (signal.aborted) return;
  if (!site) {
    root.replaceChildren(
      errorState({message: '账户服务暂时无法访问。'}, async () => {
        await refreshSite();
        if (!signal.aborted) navigate(url.pathname);
      })
    );
    return;
  }
  if (!site.user) {
    root.replaceChildren(
      el('div', {className: 'page-heading'}, el('h1', {text: '我的账户'})),
      banner('登录后可以管理账户与购买记录。公开资源和已有卡密无需登录。'),
      el('div', {className: 'row'}, [
        link('登录账户', '/user/authentication/login', {className: 'button button-primary'}, 'lock'),
        link('使用卡密兑换', '/redeem', {className: 'button'}, 'arrow-right'),
      ])
    );
    return;
  }
  const user = site.user;
  const avatarURL = safeURL(user.avatar);
  const avatar = el(
    'div',
    {className: 'account-avatar'},
    avatarURL
      ? el('img', {src: avatarURL, alt: '', width: 64, height: 64, referrerpolicy: 'no-referrer'})
      : user.username.slice(0, 1).toUpperCase()
  );
  const actions = [
    ['订单查询', '查找订单、卡密与发货内容', '/user/index/query', 'search'],
    ['账户充值', '使用原有支付通道充值', '/user/recharge/index', 'plus'],
    ['收支账单', '核对账户余额变动明细', '/user/bill/index', 'layers'],
    ['个人资料', '修改头像与账户资料', '/user/security/personal', 'sliders'],
    ['账户安全', '修改登录密码与绑定信息', '/user/security/password', 'lock'],
    ['卡密兑换', '查看并下载已授权的资源', '/redeem', 'arrow-right'],
  ];
  root.replaceChildren(
    el(
      'div',
      {className: 'page-heading'},
      el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [
        link('资源广场', '/'),
        icon('chevron-right', 12),
        el('span', {text: '我的账户'}),
      ])
    ),
    el('section', {className: 'content-panel'}, [
      el('div', {className: 'account-head'}, [
        avatar,
        el('div', {}, [
          el('h1', {text: `你好，${user.username}`}),
          el('p', {className: 'small', text: user.group_name || '我的账户'}),
        ]),
      ]),
      el('dl', {className: 'info-grid'}, [
        el('div', {}, [
          el('dt', {text: '可用余额'}),
          el('dd', {className: 'price', text: money(user.balance)}),
        ]),
        el('div', {}, [el('dt', {text: '账户编号'}), el('dd', {text: String(user.id)})]),
      ]),
    ]),
    el(
      'nav',
      {className: 'account-grid', 'aria-label': '账户操作'},
      actions.map(([title, description, href, name]) =>
        el('a', {className: 'account-tile', href}, [
          icon(name, 23),
          el('div', {}, [el('h3', {text: title}), el('p', {text: description})]),
        ])
      )
    ),
    el('section', {className: 'help-strip'}, [
      el('p', {className: 'small', text: '充值、账单与安全设置沿用现有账户中心，余额和登录状态保持一致。'}),
      link('退出登录', '/user/authentication/logout', {className: 'text-link'}, 'external-link'),
    ])
  );
}
