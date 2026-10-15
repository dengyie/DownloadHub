// Single source of truth for the site brand shown across the SPA shell,
// page titles and navigation. Rebrand by editing this file plus the static
// defaults in index.html and the assets under /brand/.
export const SITE_NAME = 'MangoQWQ 资源站';
export const WORDMARK_MAIN = 'MangoQWQ';
export const WORDMARK_SUB = '资源站';
export const HOME_EYEBROW = 'MANGOQWQ / RESOURCE LIBRARY';

export function pageTitle(title) {
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}
