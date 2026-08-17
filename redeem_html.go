package main

// redeemHTML 兑换页: 输入卡号+密钥 -> 调 /api/redeem -> 列出可下载资源 -> 跳 /dl/ 下载。
// 品牌化重构: 黑底 + 橘猫品牌色(橙/绿)，内嵌品牌图标，页脚指向二开仓库。
// 内嵌 HTML 使单二进制自适应部署(无静态资源托管依赖)。
const redeemHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<title>MangoQWQ 资源兑换</title>
<link rel="icon" href="/brand/favicon.ico">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<style>
:root{
  --bg:#0b0d10; --bg2:#101318; --card:#15181d; --card2:#1b1f26;
  --ink:#e8eaed; --muted:#8b95a3; --faint:#5a6572;
  --acc:#ffa600; --acc-dim:rgba(255,166,0,.12);
  --grn:#5ba300; --line:rgba(255,255,255,.07); --err:#ff6b6b;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;background:
  radial-gradient(1100px 500px at 50% -10%, rgba(255,166,0,.07), transparent 60%),
  radial-gradient(800px 400px at 85% 110%, rgba(91,163,0,.06), transparent 60%),
  var(--bg);
  color:var(--ink);font:15px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{flex:1;display:flex;align-items:center;justify-content:center;width:100%;padding:32px 16px}
.wrap{width:min(460px,100%);background:var(--card);border:1px solid var(--line);border-radius:18px;
  padding:32px 28px;box-shadow:0 24px 70px rgba(0,0,0,.5)}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.brand img{width:46px;height:46px;border-radius:12px;box-shadow:0 6px 18px rgba(255,166,0,.22)}
.brand .t1{font-size:18px;font-weight:700;letter-spacing:.2px}
.brand .t2{font-size:12px;color:var(--muted);margin-top:2px}
h1{font-size:21px;margin:0 0 6px;font-weight:700}
.sub{color:var(--muted);font-size:13px;margin:0 0 24px;line-height:1.6}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px;font-weight:500}
input{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:10px;font-size:15px;
  outline:none;background:var(--bg2);color:var(--ink);transition:border-color .15s, box-shadow .15s}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-dim)}
input::placeholder{color:var(--faint)}
button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:10px;
  background:linear-gradient(135deg,#ffa600,#ff8c00);color:#1a1200;font-size:15px;font-weight:700;
  cursor:pointer;transition:transform .12s ease, filter .15s;letter-spacing:.5px}
button:hover{filter:brightness(1.06)}
button:active{transform:scale(.985)}
button:disabled{opacity:.5;cursor:not-allowed}
#result{margin-top:22px}
.err{color:var(--err);font-size:14px;padding:11px 13px;background:rgba(255,107,107,.08);
  border:1px solid rgba(255,107,107,.2);border-radius:9px}
.ok{font-size:13px;color:var(--grn);margin:0 0 10px;font-weight:600}
.res{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 14px;
  border:1px solid var(--line);border-radius:10px;background:var(--card2);margin-bottom:8px;font-size:15px}
.res span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.res a{color:var(--acc);text-decoration:none;font-weight:600;white-space:nowrap;flex-shrink:0}
.res a:hover{text-decoration:underline}
.hint{text-align:center;color:var(--faint);font-size:12px;margin-top:22px;line-height:1.6}
.loading{text-align:center;color:var(--muted);margin-top:20px}
footer{width:100%;text-align:center;padding:20px 16px 28px;font-size:12px;color:var(--faint)}
footer a{color:var(--muted);text-decoration:none;transition:color .15s}
footer a:hover{color:var(--acc)}
footer .sep{margin:0 8px;opacity:.4}
@media (max-width:480px){.wrap{padding:26px 20px}.brand img{width:40px;height:40px}}
</style>
</head>
<body>
<main>
<div class="wrap">
  <div class="brand">
    <img src="/brand/logo.png" alt="MangoQWQ">
    <div>
      <div class="t1">MangoQWQ 资源站</div>
      <div class="t2">download.mangoqwq.com</div>
    </div>
  </div>
  <h1>资源兑换</h1>
  <p class="sub">输入您收到的卡号与密钥，即可获取资源下载链接。</p>
  <label>卡号</label>
  <input id="card" inputmode="text" autocomplete="off" placeholder="请输入卡号" spellcheck="false">
  <label>密钥</label>
  <input id="key" inputmode="text" autocomplete="off" placeholder="请输入密钥" spellcheck="false">
  <button id="go">立即兑换</button>
  <div id="result"></div>
  <p class="hint">兑换成功后链接 10 分钟内有效，请及时下载。<br>如兑换出现问题，请联系您的购买渠道。</p>
</div>
</main>
<footer>
  <a href="https://github.com/dengyie/cardgw" target="_blank" rel="noopener">开源项目</a>
  <span class="sep">·</span>
  <span>&copy; MangoQWQ</span>
</footer>
<script>
const $=s=>document.querySelector(s);
$('#go').onclick=async()=>{
  const card=$('#card').value.trim(), key=$('#key').value.trim();
  const box=$('#result');
  if(!card||!key){box.innerHTML='<div class="err">请填写卡号和密钥</div>';return}
  $('#go').disabled=true;
  box.innerHTML='<div class="loading">验证中…</div>';
  try{
    const f=new URLSearchParams();f.set('card',card);f.set('key',key);
    const r=await fetch('/api/redeem',{method:'POST',body:f});
    const j=await r.json();
    const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if(j.code!==200){box.innerHTML='<div class="err">'+esc(j.msg||'验证失败')+'</div>';return}
    let h='<p class="ok">兑换成功，剩余 '+esc(j.quota)+' 次下载机会：</p>';
    h+=j.resources.map(x=>'<div class="res"><span>'+esc(x.name)+'</span><a href="'+esc(x.path)+'">下载 →</a></div>').join('');
    box.innerHTML=h;
  }catch(e){box.innerHTML='<div class="err">网络错误，请稍后重试</div>'}
  $('#go').disabled=false;
};
$('#key').addEventListener('keydown',e=>{if(e.key==='Enter')$('#go').click()});
</script>
</body>
</html>`
