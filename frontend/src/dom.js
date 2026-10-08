import {uiIcon} from './vendor/UiIcon.js';
import {safeURL} from './api.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className' || key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [children].flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, size = 20) {
  const node = el('span', {className: 'icon', 'aria-hidden': 'true'});
  node.innerHTML = uiIcon(name, {size});
  return node;
}
export const button = (text, attrs = {}, name) => el('button', {type: 'button', className: 'button', ...attrs}, [name && icon(name, 18), el('span', {text})]);
export const link = (text, href, attrs = {}, name) => el('a', {href, ...attrs}, [name && icon(name, 18), el('span', {text})]);

export function banner(message, kind = 'info') {
  return el('div', {className: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status'}, [icon(kind === 'error' ? 'circle-x' : 'check-circle', 18), el('div', {text: message})]);
}
export function emptyState(title, detail, action) {
  return el('section', {className: 'empty-state'}, [el('div', {className: 'empty-icon'}, icon('layers', 28)), el('h2', {text: title}), el('p', {text: detail}), action]);
}
export function loadingState(label = '正在加载') {
  return el('div', {className: 'loading-state', role: 'status'}, [icon('loader', 22), el('span', {text: label})]);
}
export function errorState(error, retry) {
  return emptyState('暂时无法加载', error?.message || '请检查网络后重试', retry && button('重新加载', {onclick: retry}, 'refresh'));
}
export function setBusy(target, busy, message) {
  target.disabled = busy;
  target.setAttribute('aria-busy', String(busy));
  if (message) target.replaceChildren(...(busy ? [icon('loader', 18)] : []), el('span', {text: message}));
}
export function inputField(label, name, attrs = {}) {
  const input = el('input', {id: attrs.id || `field-${name}`, name, ...attrs});
  const field = el('div', {className: 'form-field'}, [el('label', {for: input.id, text: label}), input]);
  return {field, input};
}
export const money = value => new Intl.NumberFormat('zh-CN', {style: 'currency', currency: 'CNY', minimumFractionDigits: 2}).format(Number(value) || 0);
export const formatBytes = bytes => !Number.isFinite(Number(bytes)) || Number(bytes) <= 0 ? '文件' : Number(bytes) >= 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${(Number(bytes) / 1024).toFixed(1)} KB`;
export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit'});
}
export async function copyText(text, container) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    let input = container.querySelector('.manual-copy');
    if (!input) {
      input = el('textarea', {className: 'manual-copy', readonly: true, 'aria-label': '自动复制不可用，请手动复制', rows: 3});
      container.append(input);
    }
    input.value = String(text);
    input.focus(); input.select();
    return false;
  }
}

// Commerce descriptions are administrator-authored HTML, never trusted executable markup.
export function renderRichText(value) {
  const output = el('div', {className: 'rich-text'});
  const doc = new DOMParser().parseFromString(typeof value === 'string' ? value : '', 'text/html');
  const allowed = new Set(['P', 'DIV', 'SPAN', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'A', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
  const discard = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META']);
  function copy(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || discard.has(node.tagName)) return;
    if (!allowed.has(node.tagName)) { [...node.childNodes].forEach(child => copy(child, parent)); return; }
    const clean = el(node.tagName.toLowerCase());
    if (node.tagName === 'A') {
      const href = safeURL(node.getAttribute('href'));
      if (href) { clean.href = href; clean.target = '_blank'; clean.rel = 'noopener noreferrer'; }
    }
    if (node.tagName === 'IMG') {
      const src = safeURL(node.getAttribute('src'));
      if (!src) return;
      clean.src = src; clean.alt = node.getAttribute('alt') || ''; clean.loading = 'lazy'; clean.referrerPolicy = 'no-referrer';
    }
    [...node.childNodes].forEach(child => copy(child, clean));
    parent.append(clean);
  }
  [...doc.body.childNodes].forEach(child => copy(child, output));
  return output;
}
