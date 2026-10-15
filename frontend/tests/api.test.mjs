import test from 'node:test';
import assert from 'node:assert/strict';
import {formFields, safeURL, safeReturnPath, request, grantSession, APIError} from '../src/api.js';

test('URLs reject executable schemes, credentials, protocol-relative links and backslashes', () => {
  for (const input of [
    'javascript:alert(1)',
    'data:text/html,x',
    '//elsewhere.test/a',
    '/\\evil.test/a',
    'https://u:p@host.test/a',
    ' https://host.test',
    'https://host.test/\nx',
  ])
    assert.equal(safeURL(input), null);
  assert.equal(safeURL('/p/文件?sign=x'), 'https://download.example.com/p/%E6%96%87%E4%BB%B6?sign=x');
  assert.equal(safeURL('https://other.test/file', {sameOrigin: true}), null);
  assert.equal(safeReturnPath('https://other.test/'), '/user/dashboard/index');
  assert.equal(safeReturnPath('/user/authentication/logout'), '/user/dashboard/index');
  assert.equal(safeReturnPath('/item/1'), '/item/1');
});

test('nested SKU and custom field values preserve their exact keys in POST encoding', () => {
  const fields = formFields({
    item_id: 3,
    sku: {颜色: '森林绿'},
    optional: null,
    remember: false,
    widget: {备注: '<hello>'},
  });
  assert.equal(fields.get('sku[颜色]'), '森林绿');
  assert.equal(fields.get('remember'), '0');
  assert.equal(fields.has('optional'), false);
  assert.equal(fields.get('widget[备注]'), '<hello>');
  assert.equal(formFields(JSON.parse('{"__proto__":{"evil":"x"}}')).toString(), '');
});

test('API failures are explicit and do not automatically repeat a mutation', async () => {
  let calls = 0;
  const fetcher = async (_path, options) => {
    calls++;
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('password'), 'private');
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({code: 403, msg: '查询密码错误'}),
    };
  };
  await assert.rejects(
    request('/user/api/index/secret', {method: 'POST', fields: {password: 'private'}, fetcher}),
    /查询密码错误/
  );
  assert.equal(calls, 1);
  await assert.rejects(
    request('/api/redeem', {
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid');
        },
      }),
    }),
    APIError
  );
});

test('grant recovery keeps the same credential after a lost response and merges parallel clicks', async () => {
  const credentials = [];
  let fail = true;
  const issue = grantSession('a'.repeat(64), {
    send: async (_path, fields) => {
      credentials.push(fields.credential);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) {
        fail = false;
        throw new Error('response lost');
      }
      return {
        url: '/p/private/test?sign=x',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        quota: 0,
      };
    },
  });
  await assert.rejects(issue(), /response lost/);
  const [a, b] = await Promise.all([issue(), issue()]);
  assert.equal(a.url, b.url);
  assert.equal(credentials.length, 2);
  assert.deepEqual(credentials, ['a'.repeat(64), 'a'.repeat(64)]);
  assert.equal(a.quota, 0);
});

test('a grant is unusable if its returned address or expiry is invalid', async () => {
  await assert.rejects(
    grantSession('x', {
      send: async () => ({
        url: 'javascript:alert(1)',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    })(),
    /下载地址无效/
  );
  await assert.rejects(
    grantSession('x', {send: async () => ({url: '/p/a?sign=x', expires_at: '2000-01-01'})})(),
    /已过期/
  );
});

test('page navigation cancellation remains distinct from network failure', async () => {
  const controller = new AbortController();
  const pending = request('/api/catalog', {
    signal: controller.signal,
    fetcher: async (_path, {signal}) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      ),
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('encoded controls and network-path return URLs remain outside the navigation allowlist', () => {
  for (const url of [
    '/%2f%2fevil.test/a',
    '/%5Cevil.test/a',
    'https://example.test/%0d%0aLocation:x',
    '/a%00b',
    '/malformed%',
  ])
    assert.equal(safeURL(url), null, url);
  assert.equal(safeReturnPath('/%2f%2fevil.test/a'), '/user/dashboard/index');
  assert.equal(
    safeURL('/p/my%20file.zip?sign=safe%3A123'),
    'https://download.example.com/p/my%20file.zip?sign=safe%3A123'
  );
});

test('generic timeouts do not prescribe a grant recovery operation for unrelated APIs', async () => {
  const fetcher = async (_path, {signal}) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {once: true})
    );
  await assert.rejects(
    request('/user/api/index/query', {fetcher, timeout: 1}),
    (error) =>
      error instanceof APIError && error.message.includes('超时') && !error.message.includes('下载授权')
  );
});

test('login returns cannot reach encoded authentication or API actions', () => {
  for (const target of [
    '/user/authentication%2flogout',
    '/user/%61uthentication/logout',
    '/%61pi/grants',
    '/user%2fapi/order/trade',
    '/user/%2561uthentication/logout',
    '/user/authentication',
    '/api',
  ])
    assert.equal(safeReturnPath(target), '/user/dashboard/index', target);
  assert.equal(safeReturnPath('/user/bill/index?page=2'), '/user/bill/index?page=2');
});
