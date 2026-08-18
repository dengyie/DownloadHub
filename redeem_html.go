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
<script>(function(){var v=localStorage.getItem('mango-theme')||'auto';document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=v==='auto'?'light dark':v})();</script>
<style>
:root{
  --bg:#0b0d10; --bg2:#101318; --card:#15181d; --card2:#1b1f26;
  --ink:#e8eaed; --muted:#9aa4b2; --faint:#7d8896;
  --acc:#ffa600; --acc-dim:rgba(255,166,0,.12);
  --grn:#7cd423; --line:rgba(255,255,255,.07); --err:#ff6b6b;
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
input{width:100%;min-height:46px;padding:12px 13px;border:1px solid var(--line);border-radius:10px;font-size:15px;
  outline:none;background:var(--bg2);color:var(--ink);transition:border-color .15s, box-shadow .15s}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-dim)}
input::placeholder{color:var(--faint)}
button{width:100%;min-height:46px;margin-top:24px;padding:13px;border:0;border-radius:10px;
  background:linear-gradient(135deg,#ffa600,#ff8c00);color:#1a1200;font-size:15px;font-weight:700;
  cursor:pointer;transition:transform .12s ease, filter .15s;letter-spacing:.5px}
button:hover{filter:brightness(1.06)}
button:focus-visible,.res a:focus-visible,footer a:focus-visible{outline:3px solid rgba(255,166,0,.55);outline-offset:3px}
button:active{transform:scale(.985)}
button:disabled{opacity:.5;cursor:not-allowed}
#result{margin-top:22px}
.err{color:#ff9b9b;font-size:14px;padding:11px 13px;background:rgba(255,107,107,.08);
  border:1px solid rgba(255,107,107,.2);border-radius:9px}
.ok{font-size:13px;color:#a8e85e;margin:0 0 10px;font-weight:600}
.res{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 14px;
  border:1px solid var(--line);border-radius:10px;background:var(--card2);margin-bottom:8px;font-size:15px}
.res span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.res a{color:var(--acc);text-decoration:none;font-weight:600;white-space:nowrap;flex-shrink:0;min-height:40px;display:inline-flex;align-items:center;padding:8px 4px}
.res a:hover{text-decoration:underline}
.copy-link{width:auto;min-width:40px;min-height:40px;margin:0;padding:8px 10px;border:1px solid rgba(255,166,0,.28);border-radius:8px;background:rgba(255,166,0,.08);color:var(--acc);font-size:12px;font-weight:600;letter-spacing:0}
.copy-link:hover{background:rgba(255,166,0,.18);filter:none}
.copy-link:active{transform:scale(.97)}
.hint{text-align:center;color:#9aa4b2;font-size:12px;margin-top:22px;line-height:1.6}
.loading{text-align:center;color:#b7c0cc;margin-top:20px}
footer{width:100%;text-align:center;padding:20px 16px 28px;font-size:12px;color:var(--faint)}
footer a{color:var(--faint);text-decoration:none;transition:color .15s}
footer a:hover{color:var(--acc)}
footer .sep{margin:0 8px;opacity:.4}
@media (max-width:480px){.wrap{padding:26px 20px}.brand img{width:40px;height:40px}}

/* 兑换页三态主题：与首页 mango-theme 保持一致 */
:root[data-theme="light"]{--bg:#f4f7fb;--bg2:#ffffff;--card:#ffffff;--card2:#f8fafc;--ink:#1f2937;--muted:#526174;--faint:#64748b;--line:rgba(31,41,55,.14)}
@media (prefers-color-scheme: light){:root[data-theme="auto"]{--bg:#f4f7fb;--bg2:#ffffff;--card:#ffffff;--card2:#f8fafc;--ink:#1f2937;--muted:#526174;--faint:#64748b;--line:rgba(31,41,55,.14)}}
:root[data-theme="light"] body,:root[data-theme="auto"] body{background:radial-gradient(circle at 12% 15%,rgba(255,166,0,.12),transparent 30%),linear-gradient(135deg,#f4f7fb,#eef3f8);}
:root[data-theme="light"] .wrap,:root[data-theme="auto"] .wrap{box-shadow:0 24px 70px rgba(31,41,55,.12);border-color:rgba(31,41,55,.12)}
:root[data-theme="light"] input,:root[data-theme="auto"] input{border-color:rgba(31,41,55,.16);color:#1f2937}
:root[data-theme="light"] input::placeholder,:root[data-theme="auto"] input::placeholder{color:#64748b}
:root[data-theme="light"] .hint,:root[data-theme="auto"] .hint{color:#526174}
.theme-picker{display:flex;justify-content:flex-end;gap:6px;margin:-12px 0 16px}
.theme-picker button{width:auto;min-height:36px;margin:0;padding:7px 9px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:12px;letter-spacing:0}
.theme-picker button.active{background:rgba(255,166,0,.14);border-color:rgba(255,166,0,.4);color:#a15c00;font-weight:700}
:root[data-theme="dark"] .theme-picker button.active{color:#ffa600}
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
  <div class="theme-picker" role="group" aria-label="主题模式">
    <button type="button" data-theme-value="auto">自适应</button>
    <button type="button" data-theme-value="light">白天</button>
    <button type="button" data-theme-value="dark">夜晚</button>
  </div>
  <h1>资源兑换</h1>
  <p class="sub">输入您收到的卡号与密钥，即可获取资源下载链接。</p>
  <label for="card">卡号</label>
  <input id="card" inputmode="text" autocomplete="off" placeholder="请输入卡号" spellcheck="false">
  <label for="key">密钥</label>
  <input id="key" inputmode="text" autocomplete="off" placeholder="请输入密钥" spellcheck="false">
  <button id="go">立即兑换</button>
  <div id="result" role="status" aria-live="polite"></div>
  <p class="hint">兑换成功后链接 10 分钟内有效，请及时下载。<br>如兑换出现问题，请联系您的购买渠道获取帮助。</p>
</div>
</main>
<footer>
  <a href="https://github.com/dengyie/cardgw" target="_blank" rel="noopener">开源项目</a>
  <span class="sep">·</span>
  <span>&copy; MangoQWQ</span>
</footer>
<script>
const $=s=>document.querySelector(s);
const themeKey='mango-theme';
const themeLabels={auto:'自适应',light:'白天',dark:'夜晚'};
function applyTheme(value){
  value=value==='light'||value==='dark'?value:'auto';
  document.documentElement.dataset.theme=value;
  document.documentElement.style.colorScheme=value==='auto'?'light dark':value;
  document.querySelectorAll('[data-theme-value]').forEach(x=>x.classList.toggle('active',x.dataset.themeValue===value));
}
applyTheme(localStorage.getItem(themeKey)||'auto');
document.addEventListener('click',e=>{
  const target=e.target.closest('[data-theme-value]');
  if(!target)return;
  localStorage.setItem(themeKey,target.dataset.themeValue);
  applyTheme(target.dataset.themeValue);
});
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
    h+=j.resources.map(x=>'<div class="res"><span>'+esc(x.name)+'</span><a href="'+esc(x.path)+'" target="_blank" rel="noopener">下载 →</a><button type="button" class="copy-link" data-link="'+esc(x.path)+'">复制</button></div>').join('');
    box.innerHTML=h;
    box.querySelectorAll('.copy-link').forEach(btn=>btn.addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText(btn.dataset.link);btn.textContent='已复制';setTimeout(()=>btn.textContent='复制',1600)}
      catch(e){btn.textContent='请长按复制';setTimeout(()=>btn.textContent='复制',1800)}
    }));
  }catch(e){box.innerHTML='<div class="err">网络错误，请稍后重试</div>'}
  $('#go').disabled=false;
};
$('#key').addEventListener('keydown',e=>{if(e.key==='Enter')$('#go').click()});
</script>
</body>
</html>`
