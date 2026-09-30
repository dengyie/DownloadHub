(function () {
  'use strict';

  function safeURL(value, base) {
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u0020\\]/.test(value)) throw new Error('服务返回了无效下载地址');
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务返回了无效下载地址');
    return url.href;
  }

  async function requestJSON(path, fields, fetcher = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(path, {method: 'POST', body: new URLSearchParams(fields), signal: controller.signal, credentials: 'same-origin', cache: 'no-store'});
      let data;
      try { data = await response.json(); } catch (_) { throw new Error('服务器响应异常，请重试'); }
      if (!response.ok || data.code !== 200) throw new Error(data.msg || '操作失败，请重试');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请重试；同一授权不会重复扣次');
      if (error instanceof TypeError) throw new Error('网络连接失败，请重试');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function submitRedemption({button, card, key, resource, request, render, showError}) {
    if (button.disabled) return;
    if (!card || !key) { showError('请填写卡号和密钥'); return; }
    button.disabled = true;
    try {
      const fields = {card, key};
      if (resource) fields.resource = resource;
      const data = await request('/api/redeem', fields);
      if (!Array.isArray(data.resources) || data.resources.some(r => typeof r.name !== 'string' || typeof r.credential !== 'string' || !r.credential)) throw new Error('服务器资源列表异常');
      render(data);
    } catch (error) { showError(error.message || '兑换失败，请重试'); }
    finally { button.disabled = false; }
  }

  // The same credential survives a lost response; retrying asks the server for the same grant.
  function grantSession(credential, request, base, now = Date.now) {
    let pending;
    return async function issue() {
      if (!pending) pending = (async () => {
        const data = await request('/api/grants', {credential});
        const url = safeURL(data.url, base);
        if (!Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now()) throw new Error('下载授权已过期，请重新查看资源');
        return {...data, url};
      })();
      try { return await pending; } finally { pending = null; }
    };
  }

  async function copyURL(url, clipboard, showFallback) {
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await clipboard.writeText(url);
      return true;
    } catch (_) { showFallback(url); return false; }
  }

  function applyTheme(document, storage, matchMedia, value) {
    if (value === undefined) { try { value = storage.getItem('mango-theme'); } catch (_) {} }
    value = value === 'dark' || value === 'light' ? value : 'auto';
    const hour = new Date().getHours();
    const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = value === 'auto' ? (dark || hour >= 19 || hour < 7 ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = value;
    document.documentElement.dataset.resolvedTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelectorAll('[data-theme-value]').forEach(el => {
      el.classList.toggle('active', el.dataset.themeValue === value);
      el.setAttribute('aria-pressed', String(el.dataset.themeValue === value));
    });
    try { storage.setItem('mango-theme', value); } catch (_) {}
  }

  function attachApp(document, window) {
    let storage;
    try { storage = window.localStorage; } catch (_) {}
    const theme = value => applyTheme(document, storage, window.matchMedia && window.matchMedia.bind(window), value);
    theme();
    document.querySelectorAll('[data-theme-value]').forEach(el => el.addEventListener('click', () => theme(el.dataset.themeValue)));
    const box = document.querySelector('#result');
    const button = document.querySelector('#go');
    const request = (path, fields) => requestJSON(path, fields, window.fetch.bind(window));
    const element = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const showError = message => box.replaceChildren(element('div', 'err', message));
    const render = data => {
      const summary = element('p', 'ok', typeof data.quota === 'number' ? `剩余 ${data.quota} 次下载授权；选择资源签发：` : '请确认资源后签发下载授权；剩余次数将在签发时核验。');
      box.replaceChildren(summary);
      data.resources.forEach(resource => {
        const entry = element('div', 'resource-entry');
        const row = element('div', 'res');
        const name = element('span', 'resource-name', resource.name);
        const download = element('button', 'grant-download', '签发下载授权'); download.type = 'button';
        const copy = element('button', 'copy-link', '复制'); copy.type = 'button'; copy.disabled = true;
        const status = element('div', 'grant-status'); status.setAttribute('aria-live','polite');
        const open = element('a', 'open-download', '打开下载链接 ↗');
        open.target = '_blank'; open.rel = 'noopener noreferrer'; open.hidden = true;
        const issue = grantSession(resource.credential, request, window.location.href);
        let grant;
        download.addEventListener('click', async () => {
          if (download.disabled) return;
          download.disabled = true;
          open.hidden = true;
          status.className = 'grant-status'; status.textContent = '正在准备下载授权…';
          try {
            grant = await issue();
            summary.textContent = `剩余 ${grant.quota} 次下载授权`;
            copy.disabled = false; download.textContent = '核验并恢复链接';
            status.textContent = `有效至 ${new Date(grant.expires_at).toLocaleString()}；点击下方链接在新页面下载，本页保留恢复入口`;
            open.href = grant.url; open.hidden = false;
          } catch (error) { grant = null; copy.disabled = true; status.className = 'grant-status err'; status.textContent = error.message; }
          finally { download.disabled = false; }
        });
        open.addEventListener('click', event => {
          if (!grant || Date.parse(grant.expires_at) <= Date.now()) {
            event.preventDefault(); open.hidden = true; copy.disabled = true;
            status.className = 'grant-status err'; status.textContent = '下载授权已过期，请重新查看资源';
          }
        });
        copy.addEventListener('click', async () => {
          if (!grant || copy.disabled) return;
          if (Date.parse(grant.expires_at) <= Date.now()) { status.className = 'grant-status err'; status.textContent = '下载授权已过期，请重新查看资源'; copy.disabled = true; return; }
          const copied = await copyURL(grant.url, window.navigator.clipboard, url => {
            let input = entry.querySelector('.manual-copy');
            if (!input) { input = element('input', 'manual-copy'); input.readOnly = true; input.setAttribute('aria-label', '下载链接，请手动复制'); entry.appendChild(input); }
            input.value = url; input.focus(); input.select(); status.textContent = '自动复制不可用，链接已选中，请手动复制';
          });
          if (copied) {
            copy.textContent = '✓ 已复制'; copy.classList.add('copied');
            window.setTimeout(() => { copy.textContent = '复制'; copy.classList.remove('copied'); }, 1800);
          }
        });
        row.append(name, download, copy); entry.append(row, status, open); box.appendChild(entry);
      });
      if (!data.resources.length) box.appendChild(element('div', 'hint', '旧前缀卡请填写具体资源路径后重新查看；路径需在卡的授权范围内。'));
    };
    // Historical GET links only prepare a confirmation screen. No request or debit occurs here.
    const entryURL = new URL(window.location.href);
    if (entryURL.pathname.startsWith('/dl/')) {
      try {
        const resource = decodeURIComponent(entryURL.pathname.slice('/dl/'.length));
        const token = entryURL.searchParams.get('token');
        if (token !== null) {
          if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new Error('旧下载链接凭证格式无效，请使用卡号和密钥重新兑换');
          render({quota: '待核验', resources: [{name: resource.split('/').pop() || resource, credential: token}]});
        } else {
          document.querySelector('#card').value = entryURL.searchParams.get('card') || '';
          document.querySelector('#key').value = entryURL.searchParams.get('key') || '';
          document.querySelector('#resource').value = resource;
          const details = document.querySelector('.legacy-resource');
          if (details) details.open = true;
          box.replaceChildren(element('p', 'hint', '已填写旧链接信息。请先查看可用资源，再签发下载授权；打开此页面不会扣次。'));
        }
      } catch (_) { showError('旧下载链接格式无效，请使用卡号和密钥重新兑换'); }
      finally { try { window.history.replaceState(null, '', '/redeem'); } catch (_) {} }
    }
    document.querySelector('#redeem-form').addEventListener('submit', event => {
      event.preventDefault();
      return submitRedemption({button,card:document.querySelector('#card').value.trim(),key:document.querySelector('#key').value.trim(),resource:document.querySelector('#resource').value.trim(),request,render,showError});
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {safeURL, requestJSON, submitRedemption, grantSession, copyURL, applyTheme, attachApp};
  if (typeof window !== 'undefined' && typeof document !== 'undefined') attachApp(document, window);
})();
