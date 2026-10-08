// Shared by the browser and local server. Only these customer documents belong
// to the SPA; account operations, payments, APIs and unknown assets stay external.
const routes = [
  ['home', /^(?:\/|\/user\/index\/index|\/cat\/(?:\d+|recommend))$/],
  ['redeem', /^\/redeem$/],
  ['resource', /^\/resources\/[a-z0-9-]+$/],
  ['product', /^(?:\/item\/[1-9]\d*|\/user\/index\/item)$/],
  ['orders', /^(?:\/orders|\/user\/index\/query)$/],
  ['auth', /^\/user\/authentication\/(?:login|register|emailForget|phoneForget)$/],
  ['account', /^\/user\/dashboard\/index$/],
  ['help', /^\/help$/],
];

export function resolveRoute(pathname) {
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    pathname.includes('//') ||
    /[\\\u0000-\u001f\u007f]/.test(pathname)
  )
    return null;
  if (pathname.startsWith('/dl/')) {
    try {
      const resource = decodeURIComponent(pathname.slice(4));
      if (
        !resource ||
        resource.length > 2048 ||
        resource.trim() !== resource ||
        /[\\,?#\u0000-\u001f\u007f]/.test(resource) ||
        resource.split('/').some((part) => !part || part === '.' || part === '..')
      )
        return null;
      return {page: 'redeem', pathname};
    } catch {
      return null;
    }
  }
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  const route = routes.find(([, pattern]) => pattern.test(path));
  return route ? {page: route[0], pathname: path} : null;
}
