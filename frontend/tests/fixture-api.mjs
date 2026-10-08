// Synthetic browser-test data. This file is outside src/ and never enters a build.
let loggedIn = false;
let grantCount = 0;
let tradeCount = 0;
const credentials = new Map();
const orders = [];
const products = [
  {id:101,name:'开发者工具包',description:'<h2>把常用工具整理在一起</h2><p>本条目为测试预览资源，用于验证规格、优惠券、订单与卡密流程。</p>',cover:'/brand/logo.png',price:12,user_price:10,only_user:0,login:false,delivery_way:0,contact_type:2,password_status:1,coupon:1,config:{category:{'标准版':12,'完整套装':24},sku:{'平台':{'macOS':0,'Windows':0}}},stock:16,stock_state:3,inventory_hidden:0,widget:null,minimum:1,maximum:5,draft_status:0,seckill_status:0,trade_captcha:1,category_id:11,category:{id:11,name:'工具套装'},tags:['开发工具'],order_sold:0},
  {id:102,name:'部署实践手册',description:'<p>测试预览：可搜索、可查询的文档资源。</p>',cover:'',price:6,user_price:6,only_user:0,login:false,delivery_way:1,contact_type:0,password_status:0,coupon:0,config:{},stock:10,stock_state:2,inventory_hidden:0,widget:null,minimum:1,maximum:10,draft_status:0,seckill_status:0,trade_captcha:0,category_id:12,category:{id:12,name:'学习资料'},tags:['文档'],order_sold:0},
];
function reply(response,data,code=200) {response.writeHead(code===200?200:400,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify({code,...data}));}
async function body(request) {let data='';for await (const chunk of request) {data+=chunk;if(data.length>16384) throw new Error('too large');}return new URLSearchParams(data);}
export async function fixtureAPI(request,response,url) {
  const route = url.pathname;
  if (route === '/__fixture/state') {reply(response,{data:{grantCount,tradeCount}});return true;}
  if (route === '/__fixture/reset') {loggedIn=false;grantCount=0;tradeCount=0;credentials.clear();orders.length=0;reply(response,{});return true;}
  if (route === '/user/captcha/image') {
    response.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44"><rect width="120" height="44" rx="6" fill="#f2eee5"/><text x="20" y="30" font-size="26" font-family="monospace" fill="#564f41" letter-spacing="5">4286</text></svg>');return true;
  }
  if (route.startsWith('/p/fixture/')) {response.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="preview.txt"'});response.end('Synthetic download fixture. No production file or card was used.');return true;}
  if (route === '/user/authentication/logout') {loggedIn=false;response.writeHead(302,{Location:'/user/authentication/login'});response.end();return true;}
  if (!route.startsWith('/user/api/') && !['/api/redeem','/api/grants'].includes(route)) return false;
  const form = ['GET','HEAD'].includes(request.method)?url.searchParams:await body(request);
  if (route === '/user/api/storefront/bootstrap') {
    reply(response,{data:{name:'MangoQWQ 资源站',title:'实用资源，触手可及',notice:'',support_url:'',closed:false,default_category:0,from:0,auth:{registration_enabled:true,registration_type:0,registration_captcha:true,email_verification:false,phone_verification:false,login_captcha:true,username_min_length:3,recovery_type:0},user:loggedIn?{id:7,username:'mango',avatar:'/brand/logo.png',balance:'68.00',group_name:'普通会员'}:null}});
  } else if (route === '/api/redeem') {
    if (form.get('card') !== 'MANGO-DEMO' || form.get('key') !== 'preview-only') {reply(response,{msg:'卡号或密钥不正确，请检查后重试'},403);return true;}
    const key = String(credentials.size+1).padStart(64,'a');
    credentials.set(key,null);
    reply(response,{quota:2-grantCount,resources:[{name:'开发者工具包.zip',credential:key,path:'/dl/private/preview.zip'}]});
  } else if (route === '/api/grants') {
    const key = form.get('credential');
    if (!credentials.has(key)) {reply(response,{msg:'无效凭证'},403);return true;}
    let grant = credentials.get(key);
    if (!grant) {grantCount++;grant={url:'/p/fixture/toolkit?sign=synthetic',expires_at:new Date(Date.now()+600000).toISOString(),quota:2-grantCount,grant_id:'preview-grant'};credentials.set(key,grant);}
    reply(response,grant);
  } else if (route === '/user/api/index/data') reply(response,{data:[{id:11,name:'工具套装',commodity_count:1},{id:12,name:'学习资料',commodity_count:1}]});
  else if (route === '/user/api/index/commodity') {
    const search=(url.searchParams.get('keywords')||'').toLowerCase();
    const category=url.searchParams.get('categoryId')||'0';
    const data=products.filter(item=>(!search||item.name.toLowerCase().includes(search)) && (category==='0'||category==='recommend'||String(item.category_id)===category));reply(response,{data,total:data.length});
  } else if (route === '/user/api/index/commodityDetail') {
    const item=products.find(item=>item.id===Number(url.searchParams.get('commodityId')||form.get('commodityId')));
    if (!item) reply(response,{msg:'商品不存在'},404);else reply(response,{data:{...item,login:loggedIn}});
  } else if (route === '/user/api/index/valuation') {
    if(form.get('coupon')==='INVALID') reply(response,{msg:'优惠券不可用'},400);
    else reply(response,{data:{price:form.get('coupon')==='FREE'?0:(form.get('race')==='完整套装'?24:12)*Math.max(1,Number(form.get('num'))||1)}});
  } else if (route === '/user/api/index/stock') reply(response,{data:{stock:16,stock_state:3}});
  else if (route === '/user/api/index/pay') reply(response,{data:[{id:2,name:'测试支付',icon:'',handle:'fixture'},...(loggedIn?[{id:1,name:'余额支付',icon:'',handle:'balance'}]:[])]});
  else if (route === '/user/api/index/card') reply(response,{data:{list:[{id:1,draft:'预览账号 A',draft_premium:1}],total:1}});
  else if (route === '/user/api/order/trade') {
    if (form.get('captcha')!=='4286' && form.get('item_id')==='101') {reply(response,{msg:'验证码错误'},400);return true;}
    tradeCount++;
    const tradeNo=String(202610090000000000n+BigInt(tradeCount));
    const record={trade_no:tradeNo,commodity:{name:'开发者工具包',password_status:1,leave_message:'感谢使用测试预览'},status:1,delivery_status:1,password:!!form.get('password'),secret:'MANGO-DEMO / preview-only',amount:'12.00',card_num:1,create_time:'2026-10-09 10:00:00',contact:form.get('contact'),_password:form.get('password')};
    orders.push(record);reply(response,{data:{tradeNo,secret:record.secret,url:null}});
  } else if (route === '/user/api/index/query') {
    const keywords=form.get('keywords');
    const candidates=orders.length?orders:[{trade_no:'202610090000000001',commodity:{name:'开发者工具包',password_status:1},status:1,delivery_status:1,password:true,amount:'12.00',card_num:1,create_time:'2026-10-09 10:00:00',contact:'preview@example.test',_password:'preview-only',secret:'MANGO-DEMO / preview-only'}];
    const list=candidates.filter(order=>order.trade_no===keywords||order.contact===keywords).map(({_password,...order})=>order.password?{...order,secret:undefined}:order);
    reply(response,{data:{list,total:list.length}});
  } else if (route === '/user/api/index/secret') {
    const found=orders.find(order=>order.trade_no===form.get('tradeNo'));
    const password=found?found._password:'preview-only';
    if(password&&form.get('password')!==password)reply(response,{msg:'查询密码错误'},403);else reply(response,{data:{secret:'MANGO-DEMO / preview-only',widget:null,leave_message:'测试预览，不是真实订单'}});
  } else if (route.startsWith('/user/api/authentication/')) {
    if (route.endsWith('/login')||route.endsWith('/register')) {
      if(form.get('captcha')!=='4286'){reply(response,{msg:'验证码错误'},400);return true;}
      loggedIn=true;reply(response,{msg:'操作成功'});
    } else reply(response,{msg:route.endsWith('/password')?'密码已重置':'验证码已发送'});
  } else reply(response,{msg:'测试预览中未配置此接口'},404);
  return true;
}
