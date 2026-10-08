/**
 * Adapted from the user-designated awesome-ui/vanilla/ThemeToggle.js.
 * Upstream license status is documented in THIRD_PARTY_NOTICES.md.
 * Keep its three-state system/time behavior; add UiIcon, resilient storage,
 * accessibility and event cleanup for the standalone storefront.
 */
import {uiIcon} from './UiIcon.js';
class ThemeToggle extends HTMLElement {
  connectedCallback() {
    this.storageKey = this.getAttribute('storage-key') || 'mango-theme';
    this.mode = document.documentElement.dataset.theme || 'auto';
    this.innerHTML = `<div class="theme-picker inline-flex items-center" role="group" aria-label="外观模式">${[
      ['auto', 'monitor', '自动'],
      ['light', 'sun', '浅色'],
      ['dark', 'moon', '深色'],
    ]
      .map(
        ([mode, name, title]) =>
          `<button type="button" data-mode="${mode}" title="${title}主题" aria-label="${title}主题">${uiIcon(name, {size: 16})}<span>${title}</span></button>`
      )
      .join('')}</div>`;
    this.onClick = (event) => {
      const button = event.target.closest('[data-mode]');
      if (button && this.contains(button)) this.applyTheme(button.dataset.mode, true);
    };
    this.onSystem = () => this.applyTheme(this.mode);
    this.onStorage = (event) => {
      if (event.key === this.storageKey) this.applyTheme(event.newValue || 'auto');
    };
    this.addEventListener('click', this.onClick);
    this.media = window.matchMedia?.('(prefers-color-scheme: dark)');
    this.media?.addEventListener?.('change', this.onSystem);
    window.addEventListener('storage', this.onStorage);
    this.timer = setInterval(this.onSystem, 60000);
    this.applyTheme(this.mode);
  }
  disconnectedCallback() {
    this.removeEventListener('click', this.onClick);
    this.media?.removeEventListener?.('change', this.onSystem);
    window.removeEventListener('storage', this.onStorage);
    clearInterval(this.timer);
  }
  resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    const hour = new Date().getHours();
    return this.media?.matches || hour >= 19 || hour < 7 ? 'dark' : 'light';
  }
  applyTheme(mode, persist = false) {
    this.mode = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
    const resolved = this.resolveTheme(this.mode);
    document.documentElement.dataset.theme = this.mode;
    document.documentElement.dataset.resolvedTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#151715' : '#fbfaf7');
    if (persist) {
      try {
        localStorage.setItem(this.storageKey, this.mode);
      } catch {}
    }
    this.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === this.mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
    });
    this.dispatchEvent(new CustomEvent('change', {detail: {mode: this.mode, resolved}}));
  }
}
if (!customElements.get('theme-toggle')) customElements.define('theme-toggle', ThemeToggle);
export default ThemeToggle;
