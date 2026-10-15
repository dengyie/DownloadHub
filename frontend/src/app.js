import './vendor/ThemeToggle.js';
import {getJSON} from './api.js';
import {el, icon, link, button, errorState} from './dom.js';
import {renderHome} from './pages/home.js';
import {renderResource} from './pages/resource.js';
import {renderRedeem} from './pages/redeem.js';
import {renderProduct} from './pages/product.js';
import {renderOrders} from './pages/orders.js';
import {renderAuth} from './pages/auth.js';
import {renderAccount} from './pages/account.js';
import {renderHelp} from './pages/help.js';
import {resolveRoute} from './router.js';
import {SITE_NAME, WORDMARK_MAIN, WORDMARK_SUB} from './site.js';

const app = document.querySelector('#app');
const brand = () => link('', '/', {className: 'brand-link', 'aria-label': `${SITE_NAME}首页`});
function brandLink() {
  const anchor = brand();
  anchor.append(
    el('img', {src: '/brand/logo.png', alt: '', width: 37, height: 37}),
    el('span', {className: 'brand-wordmark'}, [WORDMARK_MAIN, el('small', {text: WORDMARK_SUB})])
  );
  return anchor;
}
const navItems = [
  ['资源广场', '/'],
  ['卡密兑换', '/redeem'],
  ['订单查询', '/user/index/query'],
  ['使用帮助', '/help'],
];
const nav = el(
  'nav',
  {className: 'primary-nav', id: 'primary-nav', 'aria-label': '主要导航'},
  navItems.map(([text, href]) => link(text, href))
);
const mobileAccount = link('登录 / 我的账户', '/user/dashboard/index', {className: 'mobile-account'});
nav.append(mobileAccount);
const accountLink = link('登录', '/user/authentication/login', {className: 'account-link'}, 'lock');
const menu = button(
  '',
  {
    className: 'mobile-menu',
    'aria-label': '展开导航',
    'aria-expanded': 'false',
    'aria-controls': 'primary-nav',
    onclick: () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? '收起导航' : '展开导航');
      nav.classList.toggle('mobile-open', open);
    },
  },
  'sliders'
);
const header = el(
  'header',
  {className: 'site-header'},
  el('div', {className: 'container header-inner'}, [
    brandLink(),
    nav,
    el('div', {className: 'header-actions'}, [
      el('theme-toggle', {'storage-key': 'mango-theme'}),
      accountLink,
      menu,
    ]),
  ])
);
const main = el('main', {id: 'main', className: 'site-main container', tabindex: '-1'});
const footer = el(
  'footer',
  {className: 'site-footer'},
  el('div', {className: 'container footer-inner'}, [
    el('div', {className: 'footer-left'}, [
      el('span', {className: 'footer-mark', text: SITE_NAME}),
      el('span', {text: `© ${new Date().getFullYear()} · 好工具，值得被找到。`}),
    ]),
    el('div', {className: 'footer-links'}, [
      link('使用帮助', '/help'),
      link('卡密兑换', '/redeem'),
      link('订单查询', '/user/index/query'),
    ]),
  ])
);
app.append(header);
if (document.documentElement.dataset.fixture === 'true')
  app.append(
    el('div', {
      className: 'preview-banner',
      role: 'status',
      text: '交互测试预览 · 商品、账户与订单均为模拟数据，不会消耗真实卡密或产生付款',
    })
  );
if (document.documentElement.dataset.readonly === 'true')
  app.append(
    el('div', {
      className: 'preview-banner',
      role: 'status',
      text: '只读预览 · 资源来自实际接口，提交操作已关闭',
    })
  );
app.append(main, footer);
let controller, cleanup;
let sitePromise;
function refreshSite() {
  const from = new URL(location.href).searchParams.get('from');
  const referral =
    from && /^[1-9]\d*$/.test(from) && Number.isSafeInteger(Number(from)) ? `?from=${from}` : '';
  sitePromise = getJSON(`/user/api/storefront/bootstrap${referral}`)
    .then((result) => {
      const site = result.data;
      accountLink.replaceChildren(
        icon(site?.user ? 'check-circle' : 'lock', 16),
        el('span', {text: site?.user?.username || '登录'})
      );
      accountLink.href = site?.user ? '/user/dashboard/index' : '/user/authentication/login';
      mobileAccount.href = accountLink.href;
      mobileAccount.replaceChildren(el('span', {text: site?.user ? '我的账户' : '登录 / 创建账户'}));
      return site;
    })
    .catch(() => null);
  return sitePromise;
}
refreshSite();
const renderers = {
  home: renderHome,
  redeem: renderRedeem,
  resource: renderResource,
  product: renderProduct,
  orders: renderOrders,
  auth: renderAuth,
  account: renderAccount,
  help: renderHelp,
};
function renderer(path) {
  const route = resolveRoute(path);
  return route ? renderers[route.page] : null;
}
async function render({focus = false} = {}) {
  controller?.abort();
  cleanup?.();
  cleanup = undefined;
  controller = new AbortController();
  const active = controller;
  const url = new URL(location.href);
  const route = resolveRoute(url.pathname);
  if (route && route.pathname !== url.pathname) {
    url.pathname = route.pathname;
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  main.replaceChildren();
  main.classList.remove('page-transition');
  nav.classList.remove('mobile-open');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', '展开导航');
  const current =
    {
      home: '/',
      resource: '/',
      product: '/',
      redeem: '/redeem',
      orders: '/user/index/query',
      help: '/help',
    }[route?.page] || url.pathname;
  nav.querySelectorAll('a').forEach((anchor) => {
    if (anchor.getAttribute('href') === current) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  });
  const page = renderer(url.pathname);
  try {
    if (!page) main.append(errorState({message: '这个页面不存在，请返回资源广场。'}, () => navigate('/')));
    else {
      const result = await page(main, {url, signal: active.signal, navigate, sitePromise, refreshSite});
      if (active.signal.aborted) {
        if (typeof result === 'function') result();
      } else cleanup = result;
    }
  } catch (error) {
    if (!active.signal.aborted && error.name !== 'AbortError')
      main.replaceChildren(errorState(error, () => render()));
  }
  if (!active.signal.aborted) {
    main.classList.add('page-transition');
    if (focus) main.focus({preventScroll: true});
    if (url.hash) {
      try {
        const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (target && main.contains(target)) target.scrollIntoView({behavior: 'instant', block: 'start'});
      } catch {
        /* A malformed fragment must not break the document. */
      }
    }
  }
}
function navigate(href) {
  const next = new URL(href, location.href);
  if (next.origin !== location.origin || !renderer(next.pathname)) {
    location.assign(next.href);
    return;
  }
  history.pushState(null, '', next.pathname + next.search + next.hash);
  window.scrollTo({top: 0, behavior: 'instant'});
  render({focus: true});
}
document.addEventListener('click', (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const anchor = event.target.closest('a[href]');
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const next = new URL(anchor.href, location.href);
  if (next.origin !== location.origin || !renderer(next.pathname)) return;
  if (next.pathname === location.pathname && next.search === location.search && next.hash) return;
  event.preventDefault();
  navigate(next.href);
});
window.addEventListener('popstate', () => render({focus: true}));
render();
