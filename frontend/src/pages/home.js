import {getJSON} from '../api.js';
import {el,icon,link,button,banner,emptyState,loadingState,formatBytes,formatDate,money} from '../dom.js';
import {categories,categoryIcon,filterPublic,flattenCategories} from '../catalog.js';

function hero() {
  return el('section',{className:'hero','aria-label':'欢迎来到资源站'},[
    el('div',{},[el('p',{className:'eyebrow',text:'MANGOQWQ / RESOURCE LIBRARY'}),el('h1',{},['好用的资源，',el('br'),el('em',{text:'都在这里。'})]),el('p',{className:'hero-description',text:'收集实用工具，分享值得拥有的资源。\n从开发效率到日常生活，让每一次下载都简单一点。'}),el('div',{className:'hero-benefits'},[el('span',{},[icon('check-circle',15),'公开资源直接下载']),el('span',{},[icon('lock',15),'专属资源卡密兑换'])])]),
    el('aside',{className:'redeem-promo'},[el('div',{className:'promo-top'},[el('span',{text:'YOUR RESOURCES, UNLOCKED'}),icon('lock',18)]),el('h2',{text:'已经有卡密了？'}),el('p',{text:'输入卡号与密钥，领取属于你的资源。'}),link('前往兑换','/redeem',{className:'promo-action'},'arrow-right')]),
  ]);
}
function publicCard(item) {
  const href=`/resources/${encodeURIComponent(item.id)}`;
  return el('article',{className:'resource-card','data-resource-id':item.id},[
    el('div',{className:'resource-card-top'},[el('div',{className:`resource-icon ${item.category}`},icon(categoryIcon(item.category),23)),el('span',{className:'badge',text:'公开下载'})]),
    el('h3',{},link(item.name,href)),el('p',{className:'resource-description',text:item.description}),
    el('div',{className:'resource-meta'},[el('span',{text:item.platform}),el('span',{text:item.version.startsWith('v')?item.version:`v${item.version}`}),el('span',{text:formatBytes(item.bytes)})]),
    el('div',{className:'resource-card-footer'},[el('span',{text:formatDate(item.updated_at)}),el('span',{className:'card-action'},['查看资源',icon('arrow-right',14)])]),
  ]);
}
function productCard(item) {
  const demo=item.name==='DEMO';
  return el('article',{className:'resource-card','data-product-id':String(item.id)},[
    el('div',{className:'resource-card-top'},[el('div',{className:'resource-icon commerce'},icon('layers',23)),el('span',{className:'badge badge-card',text:demo?'演示商品':'卡密资源'})]),
    el('h3',{},link(item.name,`/item/${item.id}`)),el('p',{className:'resource-description',text:demo?'商城预置的演示条目，可查看商品详情与购买流程。':`${item.category?.name || '数字资源'} · ${Number(item.delivery_way)===0?'确认订单后自动发货':'下单后由资源提供方交付'}`}),
    el('div',{className:'resource-meta'},[el('span',{text:Number(item.stock_state)>0?'有货':'暂时缺货'}),el('span',{text:Number(item.delivery_way)===0?'自动发货':'在线发货'})]),
    el('div',{className:'resource-card-footer'},[el('span',{text:money(item.price)}),el('span',{className:'card-action'},['查看详情',icon('arrow-right',14)])]),
  ]);
}

export async function renderHome(root,{url,signal}) {
  document.title='MangoQWQ 资源站 · 好用的资源，都在这里';
  let category=url.searchParams.get('category')||'all';
  if(url.pathname.startsWith('/cat/'))category=`shop-${url.pathname.split('/').pop()}`;
  if(url.searchParams.has('cid'))category=`shop-${url.searchParams.get('cid')}`;
  let query=url.searchParams.get('q')||url.searchParams.get('keywords')||'';
  let page=Math.max(1,Number(url.searchParams.get('page'))||1);
  let view=url.searchParams.get('view')==='list'?'list':'grid';
  let generation=0,fetchController,timer;
  const catalogPromise=getJSON('/api/catalog',{signal}).then(data=>Array.isArray(data.resources)?data.resources:Promise.reject(new Error('资源目录格式异常')));
  const categoriesPromise=getJSON('/user/api/index/data',{signal}).then(data=>flattenCategories(data.data)).catch(()=>[]);
  // Attach rejection handlers immediately; independent services can fail in either order.
  const publicResult=catalogPromise.then(resources=>({resources}),error=>({error,resources:[]}));
  const count=el('span',{className:'count-badge',text:'…','aria-label':'当前显示资源数量'});
  const search=el('input',{type:'search',id:'resource-search',placeholder:'搜索工具、应用或脚本…',value:query,autocomplete:'off','aria-label':'搜索资源'});
  const tabs=el('div',{className:'category-tabs',role:'group','aria-label':'资源分类'});
  const gridButton=button('',{title:'网格视图','aria-label':'网格视图','aria-pressed':String(view==='grid')},'layers');
  const listButton=button('',{title:'列表视图','aria-label':'列表视图','aria-pressed':String(view==='list')},'sliders');
  const grid=el('div',{className:`resource-grid${view==='list'?' list-view':''}`,'aria-label':'资源列表'});
  const feedback=el('div');
  const pagination=el('div',{className:'pagination'});
  const summary=el('p',{className:'catalog-summary',role:'status'});
  root.append(hero(),el('section',{'aria-label':'资源目录'},[
    el('div',{className:'catalog-heading'},[el('div',{className:'heading-title'},[el('h2',{text:'发现资源'}),count]),el('div',{className:'search-field'},[icon('search',17),search,el('kbd',{className:'search-key','aria-hidden':'true',text:'/'})])]),
    el('div',{className:'catalog-toolbar'},[tabs,el('div',{className:'view-switch',role:'group','aria-label':'显示方式'},[gridButton,listButton])]),feedback,grid,pagination,summary,
  ]),el('section',{className:'help-strip'},[
    el('div',{className:'help-strip-text'},[icon('tool',22),el('div',{},[el('h3',{text:'第一次使用？从这里开始。'}),el('p',{text:'了解下载方式、卡密兑换和常见问题，让资源顺利到手。'})])]),link('阅读使用指南','/help',{className:'text-link'},'arrow-right'),
  ]));
  function syncURL() {
    const target=new URL(location.href);target.pathname='/';
    for(const [key,value] of [['category',category==='all'?'':category],['q',query.trim()],['page',page===1?'':String(page)],['view',view==='grid'?'':'list']])if(value)target.searchParams.set(key,value);else target.searchParams.delete(key);
    target.searchParams.delete('cid');target.searchParams.delete('keywords');
    history.replaceState(null,'',target.pathname+target.search);
  }
  function drawTabs(extra=[]) {
    tabs.replaceChildren(...[...categories,...extra].map(item=>button(item.name,{
      className:'category-tab','aria-pressed':String(category===item.id),onclick:()=>{category=item.id;page=1;syncURL();drawTabs(extra);load();},
    },item.icon)));
  }
  function setView(next) {view=next;grid.classList.toggle('list-view',view==='list');gridButton.setAttribute('aria-pressed',String(view==='grid'));listButton.setAttribute('aria-pressed',String(view==='list'));syncURL();}
  gridButton.addEventListener('click',()=>setView('grid'));listButton.addEventListener('click',()=>setView('list'));
  search.addEventListener('input',()=>{query=search.value;page=1;clearTimeout(timer);timer=setTimeout(()=>{syncURL();load();},250);});
  document.addEventListener('keydown',event=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)&&!document.activeElement?.isContentEditable){event.preventDefault();search.focus();}},{signal});
  async function load() {
    const token=++generation;fetchController?.abort();fetchController=new AbortController();
    const requestSignal=AbortSignal.any([signal,fetchController.signal]);
    grid.replaceChildren(loadingState('正在寻找好用的资源'));grid.setAttribute('aria-busy','true');feedback.replaceChildren();pagination.replaceChildren();summary.textContent='';
    const hasCommerce=category==='all'||category==='commerce'||category.startsWith('shop-');
    const params=new URLSearchParams({keywords:query.trim(),limit:'12',page:String(page),categoryId:category.startsWith('shop-')?category.slice(5):'0'});
    const shopPromise=hasCommerce?getJSON(`/user/api/index/commodity?${params}`,{signal:requestSignal}).then(result=>({items:Array.isArray(result.data)?result.data:[],total:Number(result.total)||0}),error=>({items:[],total:0,error})):Promise.resolve({items:[],total:0});
    const [publicData,shop]=await Promise.all([publicResult,shopPromise]);
    if(signal.aborted||token!==generation)return;
    const publicItems=page===1?filterPublic(publicData.resources,category,query):[];
    const cards=[...publicItems.map(publicCard),...shop.items.map(productCard)];
    count.textContent=String(cards.length);grid.removeAttribute('aria-busy');
    grid.replaceChildren(...cards);
    if(publicData.error&&category!=='commerce'&&!category.startsWith('shop-'))feedback.append(banner('公开资源暂时无法加载，请稍后刷新。商城资源仍可浏览。','warning'));
    if(shop.error&&shop.error.name!=='AbortError')feedback.append(banner('商城资源暂时无法加载，公开下载和卡密兑换可分别使用。','warning'));
    if(!cards.length)grid.append(emptyState(query?'没有找到匹配的资源':'这里还没有资源',query?'试试资源名称、平台，或换一个更简短的关键词。':'可以切换分类浏览其他资源，或使用卡密兑换专属资源。',button('查看全部资源',{onclick:()=>{category='all';query='';search.value='';page=1;syncURL();drawTabs();load();}},'layers')));
    if(shop.total>12||page>1){
      const previous=button('上一页',{disabled:page<=1,onclick:()=>{page--;syncURL();load();}},'chevron-left');
      const next=button('下一页',{disabled:page*12>=shop.total,onclick:()=>{page++;syncURL();load();}},'chevron-right');
      pagination.append(previous,el('span',{text:`第 ${page} 页`}),next);
    }
    summary.textContent=cards.length?`当前显示 ${cards.length} 项资源 · 公开资源无需卡密`:'每一份好资源，都值得等待。';
  }
  drawTabs();
  categoriesPromise.then(extra=>{if(!signal.aborted)drawTabs(extra);});
  await load();
  return()=>{clearTimeout(timer);fetchController?.abort();};
}
