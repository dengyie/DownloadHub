import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const children = [];
let upstream, upstreamPort, readOnlyPort, writablePort;
const forwarded = [];
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const close = (server) => new Promise((resolve) => server.close(resolve));
async function start(readonly) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const child = spawn(process.execPath, ['dev.mjs', ...(readonly ? ['--read-only'] : [])], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      CARDGW_FRONTEND_PORT: String(port),
      CARDGW_API_ORIGIN: origin,
      COMMERCE_API_ORIGIN: origin,
      PUBLIC_FILES_ORIGIN: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Dev server did not start: ${output}`)), 10000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Dev server exited ${code}: ${output}`));
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return port;
}
function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path, method}, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
    });
    req.on('error', reject).end();
  });
}

before(async () => {
  upstream = http.createServer((request, response) => {
    forwarded.push(request.url);
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Security-Policy': "default-src 'none'",
      'X-Captcha-Id': 'a'.repeat(22),
    });
    response.end(JSON.stringify({code: 200, path: request.url}));
  });
  upstreamPort = await listen(upstream);
  readOnlyPort = await start(true);
  writablePort = await start(false);
});
after(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    })
  );
  if (upstream) await close(upstream);
});

test('read-only preview permits documented reads and refuses state-changing GETs', async () => {
  const captcha = await request(readOnlyPort, '/user/captcha/image?action=login');
  assert.equal(captcha.headers['x-captcha-id'], 'a'.repeat(22));
  const module = await request(readOnlyPort, '/ui/captcha.js');
  assert.equal(module.status, 200);
  assert.equal(module.headers['cache-control'], 'no-store');
  assert.match(module.body, /export function mountCaptcha/);
  for (const path of [
    '/user/api/storefront/bootstrap',
    '/user/api/index/commodity?categoryId=1',
    '/user/captcha/image?type=login',
    '/pub/example.txt',
  ])
    assert.equal((await request(readOnlyPort, path)).status, 200, path);
  for (const path of [
    '/user/authentication/logout',
    '/user/api/order/trade',
    '/user/api/authentication/emailRegisterCaptcha',
    '/pay/notify',
  ]) {
    const before = forwarded.length;
    assert.equal((await request(readOnlyPort, path)).status, 403, path);
    assert.equal(forwarded.length, before, `${path} must never reach the upstream`);
  }
  assert.equal((await request(readOnlyPort, '/user/api/order/trade', 'POST')).status, 403);
});

test('absolute, network-path and normalized traversal request targets cannot escape the proxy', async () => {
  for (const path of [
    `http://127.0.0.1:${upstreamPort}/api/escaped`,
    `//127.0.0.1:${upstreamPort}/api/escaped`,
    `/%2f127.0.0.1:${upstreamPort}/api/escaped`,
    '/api/%2e%2e/user/api/order/trade',
    '/api/../user/api/order/trade',
    '/api/%5cfoo',
    '/api/%00foo',
    '/api/%',
  ]) {
    const before = forwarded.length;
    assert.equal((await request(writablePort, path)).status, 400, path);
    assert.equal(forwarded.length, before, `${path} must be rejected before a request`);
  }
});

test('writable preview delegates legacy customer, payment and asset paths without SPA takeover', async () => {
  for (const path of [
    '/user/bill/index',
    '/user/recharge/index',
    '/user/security/personal',
    '/user/security/password',
    '/user/pay/order?id=123',
    '/pay/notify',
    '/assets/user/js/main.js',
  ]) {
    const result = await request(writablePort, path);
    assert.equal(result.status, 200, path);
    assert.equal(JSON.parse(result.body).path, path);
    assert.equal(result.headers['content-security-policy'], "default-src 'none'");
  }
  assert.equal((await request(writablePort, '/not-a-document.js')).status, 404);
  assert.equal((await request(writablePort, '/ui/dev/missing.js')).status, 404);
});

test('the public catalog implements GET and HEAD only', async () => {
  const get = await request(writablePort, '/api/catalog');
  assert.equal(get.status, 200);
  assert.equal(JSON.parse(get.body).resources.length, 4);
  const head = await request(writablePort, '/api/catalog', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const post = await request(writablePort, '/api/catalog', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});
