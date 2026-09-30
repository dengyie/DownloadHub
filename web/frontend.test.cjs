const {test} = require('node:test');
const assert = require('node:assert/strict');
const {safeURL,requestJSON,submitRedemption,grantSession,copyURL,applyTheme} = require('./redeem.js');

test('invalid redemption always releases submit button and can retry', async () => {
 const button = {}; let error; let rendered;
 const options = {button,card:'card',key:'wrong',request:async()=>{throw new Error('invalid')},render:data=>rendered=data,showError:e=>error=e};
 await submitRedemption(options);
 assert.equal(button.disabled,false); assert.equal(error,'invalid');
 await submitRedemption({...options,key:'correct',request:async()=>({resources:[],quota:1})});
 assert.equal(rendered.quota,1); assert.equal(button.disabled,false);
});

test('network, parser and renderer failures all restore the form', async () => {
 for (const failure of [new TypeError('network'), new SyntaxError('json')]) {
  const button = {}; let error;
  await submitRedemption({button,card:'c',key:'k',request:async()=>{throw failure},showError:e=>error=e});
  assert.equal(error,failure.message);assert.equal(button.disabled,false);
 }
 const button = {};
 await submitRedemption({button,card:'c',key:'k',request:async()=>({resources:[]}),render:()=>{throw new Error('render')},showError:()=>{}});
 assert.equal(button.disabled,false);
});

test('concurrent form submits do not redeem twice', async () => {
 let release; let calls=0;
 const button={}; const options={button,card:'c',key:'k',request:()=>{calls++;return new Promise(r=>release=r)},render:()=>{},showError:assert.fail};
 const first=submitRedemption(options);await submitRedemption(options);release({resources:[]});await first;
 assert.equal(calls,1);
});

test('relative links become absolute and unsafe schemes are rejected', () => {
 const base='https://download.example/redeem';
 assert.equal(safeURL('/dl/pub/a%2520b?token=x',base),'https://download.example/dl/pub/a%2520b?token=x');
 for (const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/x','https://user:pass@host/a','https:\\evil/a','\nhttps://host/a','']) assert.throws(()=>safeURL(url,base));
});

test('failed grant retries and later downloads revalidate using the same credential', async () => {
 const calls=[];let fail=true;
 const issue=grantSession('same-secret',async(path,fields)=>{calls.push([path,fields]);if(fail){fail=false;throw new Error('lost response')};return {url:'/dl/a',expires_at:'2030-01-01T00:00:00Z',quota:2}},'https://download.example/redeem',()=>0);
 await assert.rejects(issue(),/lost response/);
 const grant=await issue();assert.equal(grant.url,'https://download.example/dl/a');assert.deepEqual(await issue(),grant);
 assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[1],calls[2]);
});

test('parallel issuance shares one request and expired result is never reused', async () => {
 let resolve,calls=0,now=0;
 const issue=grantSession('credential',()=>{calls++;return calls===1?new Promise(r=>resolve=r):Promise.resolve({url:'/dl/a',expires_at:'2030-01-01T00:00:00Z'})},'https://download.example',()=>now);
 const first=issue(),second=issue();resolve({url:'/dl/a',expires_at:'2030-01-01T00:00:00Z'});
 assert.deepEqual(await first,await second);assert.equal(calls,1);
 now=Date.parse('2031-01-01T00:00:00Z');await assert.rejects(issue(),/过期/);assert.equal(calls,2);
});

test('copy success returns true and denied clipboard selects a fallback URL', async () => {
 let copied,fallback;
 assert.equal(await copyURL('https://download.example/dl/a',{writeText:async s=>copied=s},assert.fail),true);
 assert.equal(copied,'https://download.example/dl/a');
 assert.equal(await copyURL(copied,{writeText:async()=>{throw new Error('denied')}},s=>fallback=s),false);
 assert.equal(fallback,copied);
});

test('blocked storage and absent matchMedia do not prevent theme application', () => {
 const document={documentElement:{dataset:{},style:{}},querySelectorAll:()=>[]};
 const storage={getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}};
 applyTheme(document,storage,undefined,'light');assert.equal(document.documentElement.dataset.resolvedTheme,'light');
 applyTheme(document,storage,undefined);assert.equal(document.documentElement.dataset.theme,'auto');
});

test('HTTP error, invalid JSON and network errors produce explicit messages', async () => {
 await assert.rejects(requestJSON('/api/redeem',{},async()=>({ok:false,json:async()=>({code:429,msg:'请求过多'})})),/请求过多/);
 await assert.rejects(requestJSON('/api/redeem',{},async()=>({ok:true,json:async()=>{throw new SyntaxError()}})),/响应异常/);
 await assert.rejects(requestJSON('/api/redeem',{},async()=>{throw new TypeError()}),/网络连接失败/);
 let options;
 await requestJSON('/api/grants',{credential:'x'},async(_,o)=>{options=o;return {ok:true,json:async()=>({code:200})}});
 assert.equal(options.body.get('credential'),'x');assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');
});

// Minimal DOM adapter exercises actual event wiring and rendered nodes without npm packages.
function fakeDOM() {
 class Element {
  constructor(tag='div') { this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.style={};this.attributes={};this.value='';this.className='';this.textContent='';this.disabled=false;
   this.classList={toggle:(c,v)=>{const set=new Set(this.className.split(' '));v?set.add(c):set.delete(c);this.className=[...set].join(' ')},add:c=>this.classList.toggle(c,true),remove:c=>this.classList.toggle(c,false)};
  }
  addEventListener(name,handler){this.listeners[name]=handler}
  setAttribute(name,value){this.attributes[name]=value}
  append(...children){children.forEach(child=>{child.parent=this;this.children.push(child)})}
  appendChild(child){this.append(child);return child}
  replaceChildren(...children){this.children=[];this.append(...children)}
  querySelector(selector){for(const child of this.children){if(selector.startsWith('.')&&child.className.split(' ').includes(selector.slice(1)))return child;const found=child.querySelector(selector);if(found)return found}return null}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this)}
  click(){if(this.tagName==='a')links.push(this.href);return this.listeners.click?.({target:this})}
  focus(){this.focused=true} select(){this.selected=true}
 }
 const links=[];
 const nodes=Object.fromEntries(['#card','#key','#resource','#result','#go','#redeem-form'].map(k=>[k,new Element()]));
 const document={body:new Element('body'),documentElement:new Element('html'),createElement:t=>new Element(t),querySelector:s=>nodes[s],querySelectorAll:()=>[]};
 return {document,nodes,links};
}

test('actual form and resource events render errors, submit legacy path, sign, copy and revalidate', async () => {
 const {attachApp}=require('./redeem.js');
 const {document,nodes,links}=fakeDOM();const requests=[];let mode='bad-card';let timer;
 const window={location:{href:'https://download.example/redeem'},navigator:{clipboard:{writeText:async()=>{throw new Error('denied')}}},setTimeout:f=>{timer=f},fetch:async(path,options)=>{
  requests.push({path,fields:Object.fromEntries(options.body)});
  if(mode==='bad-card') return {ok:false,json:async()=>({code:403,msg:'密钥错误'})};
  if(path==='/api/redeem')return {ok:true,json:async()=>({code:200,quota:2,resources:[{name:'<script>alert(1)</script>',credential:'same',path:'pub/a'}]})};
  if(mode==='revoked')return {ok:false,json:async()=>({code:403,msg:'卡已吊销'})};
  return {ok:true,json:async()=>({code:200,quota:1,url:'/dl/a?token=test',expires_at:'2099-01-01T00:00:00Z'})};
 }};
 Object.defineProperty(window,'localStorage',{get(){throw new Error('denied')}});
 attachApp(document,window);
 nodes['#card'].value='card';nodes['#key'].value='wrong';nodes['#resource'].value='pub/a';
 const submit=()=>nodes['#redeem-form'].listeners.submit({preventDefault(){}});
 await submit();assert.equal(nodes['#go'].disabled,false);assert.equal(nodes['#result'].children[0].textContent,'密钥错误');
 mode='valid';await submit();
 assert.equal(requests[1].fields.resource,'pub/a');
 const result=nodes['#result'];assert.equal(result.querySelector('.resource-name').textContent,'<script>alert(1)</script>');
 const download=result.querySelector('.grant-download'),copy=result.querySelector('.copy-link');
 assert.equal(copy.disabled,true);await download.click();assert.equal(copy.disabled,false);assert.deepEqual(links,[]);
 const open=result.querySelector('.open-download');assert.equal(open.href,'https://download.example/dl/a?token=test');assert.equal(open.target,'_blank');assert.equal(open.rel,'noopener noreferrer');
 await copy.click();const input=result.querySelector('.manual-copy');assert.equal(input.value,open.href);assert.equal(input.selected,true);assert.equal(input.readOnly,true);
 window.navigator.clipboard.writeText=async()=>{};await copy.click();assert.equal(copy.textContent,'✓ 已复制');timer();assert.equal(copy.textContent,'复制');
 mode='revoked';await download.click();assert.equal(download.disabled,false);assert.equal(copy.disabled,true);assert.equal(result.querySelector('.grant-status').textContent,'卡已吊销');
 const grantRequests=requests.filter(r=>r.path==='/api/grants');assert.equal(grantRequests.length,2);assert.deepEqual(grantRequests[0].fields,{credential:'same'});assert.deepEqual(grantRequests[0],grantRequests[1]);assert.equal(links.length,0);
});

test('historical token GET only renders confirmation, clears query and waits for explicit click', async () => {
 const {attachApp}=require('./redeem.js');const {document,nodes}=fakeDOM();let requests=0;let replaced;
 const credential='ab'.repeat(32);
 const window={location:{href:`https://download.example/dl/pub/a%2520b.zip?token=${credential}`},history:{replaceState:(...args)=>replaced=args},navigator:{},fetch:async(path,options)=>{requests++;assert.equal(path,'/api/grants');assert.equal(options.method,'POST');assert.equal(options.body.get('credential'),credential);return {ok:false,json:async()=>({code:403,msg:'expired'})}}};
 attachApp(document,window);
 assert.equal(requests,0);assert.deepEqual(replaced,[null,'','/redeem']);
 assert.equal(nodes['#result'].querySelector('.resource-name').textContent,'a%20b.zip');
 assert.equal(nodes['#result'].querySelector('.copy-link').disabled,true);
 await nodes['#result'].querySelector('.grant-download').click();assert.equal(requests,1);
});

test('historical card GET prefills once-decoded path without sending card secrets', () => {
 const {attachApp}=require('./redeem.js');const {document,nodes}=fakeDOM();let replaced;
 attachApp(document,{location:{href:'https://download.example/dl/pub/a%252Fb.zip?card=test&key=secret'},history:{replaceState:(...args)=>replaced=args},fetch:()=>assert.fail('GET landing must not request'),navigator:{}});
 assert.equal(nodes['#card'].value,'test');assert.equal(nodes['#key'].value,'secret');assert.equal(nodes['#resource'].value,'pub/a%2Fb.zip');assert.deepEqual(replaced,[null,'','/redeem']);
});

test('malformed historical links show errors and still remove sensitive query', () => {
 const {attachApp}=require('./redeem.js');
 for(const suffix of ['a?token=bad','a%ZZ?card=c&key=secret']) {
  const {document,nodes}=fakeDOM();let replaced;
  attachApp(document,{location:{href:'https://download.example/dl/pub/'+suffix},history:{replaceState:(...args)=>replaced=args},fetch:()=>assert.fail('no request'),navigator:{}});
  assert.equal(nodes['#result'].children[0].className,'err');assert.deepEqual(replaced,[null,'','/redeem']);
 }
});

test('last quota issuance preserves page and same-credential zero-quota recovery', async () => {
 const {attachApp}=require('./redeem.js');const {document,nodes,links}=fakeDOM();const credentials=[];let quota=1;
 const window={location:{href:'https://download.example/redeem'},navigator:{},fetch:async(path,options)=>{
  if(path==='/api/redeem')return {ok:true,json:async()=>({code:200,quota,resources:[{name:'preview.pdf',credential:'retain-this'}]})};
  credentials.push(options.body.get('credential'));quota=0;
  return {ok:true,json:async()=>({code:200,quota:0,grant_id:'same-grant',url:'/p/preview.pdf?sign=test',expires_at:'2099-01-01T00:00:00Z'})};
 }};
 attachApp(document,window);nodes['#card'].value='card';nodes['#key'].value='key';
 await nodes['#redeem-form'].listeners.submit({preventDefault(){}});
 const button=nodes['#result'].querySelector('.grant-download');await button.click();
 assert.equal(quota,0);assert.deepEqual(links,[]);assert.equal(nodes['#result'].children[0].textContent,'剩余 0 次下载授权');
 const open=nodes['#result'].querySelector('.open-download');assert.equal(open.hidden,false);assert.equal(open.target,'_blank');assert.equal(open.rel,'noopener noreferrer');
 await open.click();assert.equal(links.length,1);assert.equal(nodes['#result'].querySelector('.grant-download'),button);
 await button.click();assert.deepEqual(credentials,['retain-this','retain-this']);assert.equal(open.hidden,false);assert.equal(button.disabled,false);assert.equal(links.length,1);
});
