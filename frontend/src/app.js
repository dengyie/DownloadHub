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

const app = document.querySelector('#app');
const brand = () => link('', '/', {className:'brand-link','aria-label':'MangoQWQ 资源站首页'});
function brandLink() {
  const anchor = brand();
  anchor.append(el('img',{src:'/brand/logo.png',alt:'',width:37,height:37}),el('span',{className:'brand-wordmark'},['MangoQWQ',el('small',{text:'资源站'})]));
  return anchor;
}
const navItems=[['资源广场','/'],['卡密兑换','/redeem'],['订单查询','/user/index/query'],['使用帮助','/help']];
const nav=el('nav',{className:'primary-nav',id:'primary-nav','aria-label':'主要导航'},navItems.map(([text,href])=>link(text,href)));
const mobileAccount=link('登录 / 我的账户','/user/dashboard/index',{className:'mobile-account'});nav.append(mobileAccount);
const accountLink=link('登录','/user/authentication/login',{className:'account-link'},'lock');
const menu=button('',{className:'mobile-menu','aria-label':'展开导航','aria-expanded':'false','aria-controls':'primary-nav',onclick:()=>{
  const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'收起导航':'展开导航');nav.classList.toggle('mobile-open',open);
}},'sliders');
const header=el('header',{className:'site-header'},el('div',{className:'container header-inner'},[brandLink(),nav,el('div',{className:'header-actions'},[el('theme-toggle',{'storage-key':'mango-theme'}),accountLink,menu])]));
const main=el('main',{id:'main',className:'site-main container',tabindex:'-1'});
const footer=el('footer',{className:'site-footer'},el('div',{className:'container footer-inner'},[
  el('div',{className:'footer-left'},[el('span',{className:'footer-mark',text:'MangoQWQ 资源站'}),el('span',{text:`© ${new Date().getFullYear()} · 好工具，值得被找到。`})]),
  el('div',{className:'footer-links'},[link('使用帮助','/help'),link('卡密兑换','/redeem'),link('订单查询','/user/index/query')]),
]));
app.append(header);
if(document.documentElement.dataset.fixture==='true')app.append(el('div',{className:'preview-banner',role:'status',text:'交互测试预览 · 商品、账户与订单均为模拟数据，不会消耗真实卡密或产生付款'}));
if(document.documentElement.dataset.readonly==='true')app.append(el('div',{className:'preview-banner',role:'status',text:'只读预览 · 资源来自实际接口，提交操作已关闭'}));
app.append(main,footer);
let controller, cleanup;
let sitePromise;
function refreshSite() {
  sitePromise=getJSON('/user/api/storefront/bootstrap').then(result=>{
    const site=result.data;
    accountLink.replaceChildren(icon(site?.user?'check-circle':'lock',16),el('span',{text:site?.user?.username || '登录'}));
    accountLink.href=site?.user?'/user/dashboard/index':'/user/authentication/login';
    mobileAccount.href=accountLink.href;
    mobileAccount.replaceChildren(el('span',{text:site?.user?'我的账户':'登录 / 创建账户'}));
    return site;
  }).catch(()=>null);
}
refreshSite();
function renderer(path) {
  if(path==='/'||path==='/user/index/index'||path.startsWith('/cat/'))return renderHome;
  if(path==='/redeem'||path.startsWith('/dl/'))return renderRedeem;
  if(path.startsWith('/resources/'))return renderResource;
  if(/^\/item\/[1-9]\d*$/.test(path)||path==='/user/index/item')return renderProduct;
  if(path==='/orders'||path==='/user/index/query')return renderOrders;
  if(/^\/user\/authentication\/(login|register|emailForget|phoneForget)$/.test(path))return renderAuth;
  if(path==='/user/dashboard/index')return renderAccount;
  if(path==='/help')return renderHelp;
  return null;
}
async function render({focus=false}={}) {
  controller?.abort();cleanup?.();cleanup=undefined;
  controller=new AbortController();
  const active=controller;
  const url=new URL(location.href);
  main.replaceChildren();main.classList.remove('page-transition');
  nav.classList.remove('mobile-open');menu.setAttribute('aria-expanded','false');
  const current=url.pathname.startsWith('/dl/')?'/redeem':url.pathname;
  nav.querySelectorAll('a').forEach(anchor=>{if(anchor.getAttribute('href')===current)anchor.setAttribute('aria-current','page');else anchor.removeAttribute('aria-current');});
  const page=renderer(url.pathname);
  try {
    if(!page)main.append(errorState({message:'这个页面不存在，请返回资源广场。'},()=>navigate('/')));
    else {
      const result=await page(main,{url,signal:active.signal,navigate,sitePromise,refreshSite});
      if(!active.signal.aborted)cleanup=result;
    }
  } catch(error) {if(!active.signal.aborted&&error.name!=='AbortError')main.replaceChildren(errorState(error,()=>render()));}
  if(!active.signal.aborted){main.classList.add('page-transition');if(focus)main.focus({preventScroll:true});}
}
function navigate(href) {
  const next=new URL(href,location.href);
  if(next.origin!==location.origin){location.assign(next.href);return;}
  history.pushState(null,'',next.pathname+next.search+next.hash);
  window.scrollTo({top:0,behavior:'instant'});render({focus:true});
}
document.addEventListener('click',event=>{
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const anchor=event.target.closest('a[href]');
  if(!anchor||anchor.target||anchor.hasAttribute('download'))return;
  const next=new URL(anchor.href,location.href);
  if(next.origin!==location.origin||!renderer(next.pathname))return;
  if(next.pathname===location.pathname&&next.search===location.search&&next.hash)return;
  event.preventDefault();navigate(next.href);
});
window.addEventListener('popstate',()=>render({focus:true}));
render();
