export class APIError extends Error {
  constructor(message, {status = 0, code = '', requestId = ''} = {}) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function formFields(value) {
  const result = new URLSearchParams();
  function append(prefix, item) {
    if (item === undefined || item === null) return;
    if (typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        append(prefix ? `${prefix}[${key}]` : key, child);
      }
    } else result.append(prefix, typeof item === 'boolean' ? (item ? '1' : '0') : String(item));
  }
  append('', value);
  return result;
}

export function safeURL(
  value,
  {base = globalThis.location?.href || 'https://download.mangoqwq.com/', sameOrigin = false} = {}
) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    value.startsWith('//')
  )
    return null;
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')) return null;
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (sameOrigin && url.origin !== new URL(base).origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function safeReturnPath(value) {
  const href = safeURL(value, {sameOrigin: true});
  if (!href) return '/user/dashboard/index';
  const url = new URL(href);
  // Check the path the server will interpret, not its encoded spelling. Reject
  // ambiguous double encoding instead of guessing another component's decoder.
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.includes('%') ||
    pathname.startsWith('//') ||
    /^\/(?:user\/authentication|api|user\/api)(?:\/|$)/i.test(pathname)
  )
    return '/user/dashboard/index';
  return url.pathname + url.search + url.hash;
}

export async function request(
  path,
  {method = 'GET', fields, signal, fetcher = globalThis.fetch, timeout = 20000} = {}
) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020]/.test(path))
    throw new APIError('无效的请求地址');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
  try {
    const response = await fetcher(path, {
      method,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {Accept: 'application/json'},
      ...(fields === undefined ? {} : {body: formFields(fields)}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new APIError('服务暂时没有返回有效数据，请稍后重试', {status: response.status});
    }
    if (!response.ok || !data || Number(data.code) !== 200) {
      throw new APIError(typeof data?.msg === 'string' ? data.msg : '操作未完成，请稍后重试', {
        status: response.status,
        code: data?.error || '',
        requestId: response.headers?.get('X-Request-ID') || '',
      });
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('页面已切换', 'AbortError');
    if (controller.signal.aborted)
      throw new APIError('请求超时。提交类操作请先核对结果，避免重复操作；查询可以稍后重试。');
    if (error instanceof TypeError) throw new APIError('网络连接失败，请检查网络后重试');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const getJSON = (path, options = {}) => request(path, options);
export const postJSON = (path, fields = {}, options = {}) =>
  request(path, {...options, method: 'POST', fields});

// Keep one operation per credential. A response loss never creates a fresh debit.
export function grantSession(credential, {send = postJSON, now = Date.now} = {}) {
  let pending;
  return async function issue(options = {}) {
    if (!pending)
      pending = (async () => {
        const data = await send('/api/grants', {credential}, options);
        const url = safeURL(data.url);
        if (!url) throw new APIError('下载地址无效，请联系资源提供方');
        if (!Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now())
          throw new APIError('下载授权已过期，请重新兑换');
        return {...data, url};
      })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
