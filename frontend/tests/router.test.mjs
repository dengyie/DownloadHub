import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRoute} from '../src/router.js';

test('customer document ownership and trailing slash normalization are explicit', () => {
  for (const [path, page] of [
    ['/', 'home'],
    ['/cat/recommend', 'home'],
    ['/cat/12', 'home'],
    ['/redeem', 'redeem'],
    ['/resources/frpc-arm64', 'resource'],
    ['/item/101', 'product'],
    ['/user/index/item', 'product'],
    ['/orders', 'orders'],
    ['/user/index/query', 'orders'],
    ['/user/authentication/login', 'auth'],
    ['/user/dashboard/index', 'account'],
    ['/help', 'help'],
  ]) {
    assert.deepEqual(resolveRoute(path), {page, pathname: path});
    if (path !== '/') assert.deepEqual(resolveRoute(`${path}/`), {page, pathname: path});
  }
});

test('APIs, assets, payment, legacy account operations and malformed routes are not SPA documents', () => {
  for (const path of [
    '/api/redeem',
    '/user/api/index/query',
    '/admin',
    '/user/bill/index',
    '/user/authentication/logout',
    '/user/pay/order',
    '/pay/notify',
    '/ui/missing.js',
    '/resources/a/b',
    '/cat/bad',
    '//',
    '/redeem//',
    '/item/0',
    '/item/1/../2',
    '/dl/a/../b',
    '/dl/a//b',
    '/dl/a/',
    '/dl/%00',
    '/dl/%',
    '/dl/%2f%2fhost',
    '/dl/a%3Fcard=secret',
    '/dl/a%5cb',
  ]) {
    assert.equal(resolveRoute(path), null, path);
  }
  assert.deepEqual(resolveRoute('/dl/private/toolkit.zip'), {
    page: 'redeem',
    pathname: '/dl/private/toolkit.zip',
  });
});
