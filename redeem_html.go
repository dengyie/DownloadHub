package main

// redeemHTML 兑换页: 输入卡号+密钥 -> 调 /api/redeem -> 列出可下载资源 -> 跳 /dl/ 下载。
// 内嵌 HTML 使单二进制自适应部署(无静态资源托管依赖)。
const redeemHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>资源兑换 - 异次元</title>
<style>
:root{--bg:#f6f9fc;--card:#fff;--ink:#101820;--muted:#5f7180;--acc:#1268c4;--line:rgba(35,72,99,.12);--err:#c0392b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:15px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{width:min(480px,92vw);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 26px;box-shadow:0 22px 65px rgba(38,68,91,.09)}
h1{font-size:20px;margin:0 0 6px}
.sub{color:var(--muted);font-size:13px;margin:0 0 22px}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font-size:15px;outline:none}
input:focus{border-color:var(--acc)}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:var(--acc);color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
#result{margin-top:20px}
.err{color:var(--err);font-size:14px;padding:10px 12px;background:rgba(192,57,43,.08);border-radius:8px}
.ok{font-size:13px;color:var(--muted);margin:14px 0 6px}
.res{display:flex;justify-content:space-between;align-items:center;padding:12px 6px;border-bottom:1px solid var(--line);font-size:15px}
.res a{color:var(--acc);text-decoration:none;font-weight:500}
.hint{text-align:center;color:#9aa7b2;font-size:12px;margin-top:20px}
.loading{text-align:center;color:var(--muted);margin-top:20px}
</style>
</head>
<body>
<div class="wrap">
  <h1>资源兑换中心</h1>
  <p class="sub">请输入收到的卡号与密钥，兑换您购买的资源。</p>
  <label>卡号</label>
  <input id="card" inputmode="text" autocomplete="off" placeholder="请输入卡号">
  <label>密钥</label>
  <input id="key" inputmode="text" autocomplete="off" placeholder="请输入密钥">
  <button id="go">兑换</button>
  <div id="result"></div>
  <p class="hint">如兑换出现问题，请联系客服</p>
</div>
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
    if(j.code!==200){box.innerHTML='<div class="err">'+(j.msg||'验证失败')+'</div>';return}
    if(!j.resources||!j.resources.length){box.innerHTML='<div class="err">该卡未绑定资源，请使用站内下载链接</div>';return}
    let h='<p class="ok">兑换成功，剩余次数 '+j.quota+'。请选择资源下载：</p>';
    h+=j.resources.map(x=>'<div class="res"><span>'+x.name+'</span><a href="/dl'+encodeURIComponent((x.path[0]==='/'?'':'/')+x.path)+'?card='+encodeURIComponent(card)+'&key='+encodeURIComponent(key)+'">下载 →</a></div>').join('');
    box.innerHTML=h;
  }catch(e){box.innerHTML='<div class="err">网络错误，请重试</div>'}
  $('#go').disabled=false;
};
$('#key').addEventListener('keydown',e=>{if(e.key==='Enter')$('#go').click()});
</script>
</body>
</html>`
