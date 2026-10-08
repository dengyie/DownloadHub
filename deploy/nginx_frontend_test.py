"""Exercise the checked-in nginx boundary with real nginx and private fake APIs.

No production API, database or listener is used. Temporary evidence is retained.
Install nginx on CI, or run this test on a host that already has the binary.
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


class Upstream(BaseHTTPRequestHandler):
    def handle_request(self):
        code = 404 if self.path.startswith('/api/unknown') else 200
        body = f'{self.server.kind}:{self.command}:{self.path}'.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'public, max-age=600')
        if self.server.kind == 'commerce':
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'")
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    do_GET = do_HEAD = do_POST = handle_request

    def log_message(self, *_):
        pass


@unittest.skipUnless(shutil.which('nginx'), 'Real nginx is required for routing acceptance')
class NginxFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix='cardgw-nginx-boundary-'))
        print(f'Isolated nginx evidence: {cls.directory}', flush=True)
        cls.release = 'a' * 24
        cls.shell = b'<!doctype html><title>Isolated frontend acceptance</title>'
        cls.assets = cls.directory / 'dist'
        version = cls.assets / 'ui' / cls.release
        version.mkdir(parents=True)
        (version / 'app.js').write_text('export const fixture = true;', encoding='utf-8')
        (version / 'styles.css').write_text('body {color: black}', encoding='utf-8')
        (cls.assets / 'index.html').write_bytes(cls.shell)
        (cls.assets / 'brand').mkdir()
        (cls.assets / 'brand' / 'logo.png').write_bytes(b'fixture-image')
        (cls.directory / 'public').mkdir()
        (cls.directory / 'public' / 'example.zip').write_bytes(b'public fixture')
        (cls.directory / 'logs').mkdir()

        config = (Path(__file__).with_name('download-nginx.conf.example')).read_text(encoding='utf-8')
        config = config.replace('/var/www/download-ui/current', str(cls.assets))
        config = config.replace('/data/share/pub/', str(cls.directory / 'public') + '/')
        config = config.replace('/personal/pxed/nginx/logs/', str(cls.directory / 'logs') + '/')
        # This port is reserved only while preparing the config. All listeners
        # remain loopback, and nginx startup failure is fatal rather than reused.
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            cls.port = listener.getsockname()[1]
        config = config.replace('listen 127.0.0.1:80;', f'listen 127.0.0.1:{cls.port};')
        config = config.replace('listen [::1]:80;', '')
        for original, kind in [(8080, 'cardgw'), (8081, 'commerce'), (5244, 'files')]:
            server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
            server.kind = kind
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.addClassCleanup(server.server_close)
            cls.addClassCleanup(server.shutdown)
            config = config.replace(f'127.0.0.1:{original}', f'127.0.0.1:{server.server_port}')
        config_path = cls.directory / 'nginx.conf'
        config_path.write_text(
            f'pid {cls.directory}/nginx.pid;\nerror_log {cls.directory}/logs/error.log;\n'
            f'events {{ worker_connections 64; }}\nhttp {{\n{config}\n}}\n', encoding='utf-8')
        command = [shutil.which('nginx'), '-p', str(cls.directory), '-c', str(config_path)]
        check = subprocess.run(command + ['-t'], capture_output=True, text=True, timeout=10)
        if check.returncode:
            raise AssertionError(check.stderr)
        output = (cls.directory / 'process.log').open('wb')
        cls.addClassCleanup(output.close)
        process = subprocess.Popen(command + ['-g', 'daemon off; master_process off;'], stdout=output, stderr=output)

        def stop():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        cls.addClassCleanup(stop)
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError((cls.directory / 'process.log').read_text())
            try:
                connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=.2)
                connection.request('GET', '/health')
                connection.getresponse().read()
                connection.close()
                break
            except OSError:
                connection.close()
                time.sleep(.05)
        else:
            raise AssertionError('Isolated nginx did not become ready')

    def request(self, path, method='GET', body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request(method, path, body, {'Host': 'download.mangoqwq.com'})
            response = connection.getresponse()
            return response.status, dict((k.lower(), v) for k, v in response.getheaders()), response.read()
        finally:
            connection.close()

    def test_known_documents_are_no_store_shells_and_head_has_no_body(self):
        for path in ['/', '/redeem', '/help/', '/orders', '/resources/tool', '/item/101',
                     '/cat/recommend', '/user/index/item?commodityId=101', '/user/index/query',
                     '/user/authentication/login?goto=/user/dashboard/index', '/user/dashboard/index']:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, self.shell)
                self.assertEqual(headers.get('cache-control'), 'no-store')
                self.assertIn('text/html', headers.get('content-type', ''))
                self.assertIn("script-src 'self';", headers.get('content-security-policy', ''))
                self.assertEqual(self.request(path, 'HEAD')[2], b'')

    def test_post_to_a_document_never_replays_or_returns_the_shell(self):
        self.assertEqual(self.request('/redeem', 'POST', 'card=fixture')[0], 405)

    def test_assets_are_immutable_only_when_present(self):
        status, headers, body = self.request(f'/ui/{self.release}/app.js')
        self.assertEqual(status, 200)
        self.assertIn('javascript', headers.get('content-type', ''))
        self.assertIn('immutable', headers.get('cache-control', ''))
        self.assertNotEqual(body, self.shell)
        self.assertEqual(self.request(f'/ui/{self.release}/styles.css')[0], 200)
        for path in [f'/ui/{self.release}/missing.js', '/ui/missing/app.js',
                     f'/ui/{self.release}/config.yaml', '/brand/missing.png']:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn('immutable', headers.get('cache-control', ''))
                self.assertNotEqual(body, self.shell)
        self.assertEqual(self.request('/brand/logo.png')[0], 200)

    def test_cardgw_apis_keep_status_method_query_and_no_store(self):
        status, headers, body = self.request('/api/catalog?fixture=1')
        self.assertEqual(body, b'cardgw:GET:/api/catalog?fixture=1')
        self.assertEqual(headers.get('cache-control'), 'no-store')
        self.assertEqual(self.request('/api/unknown')[0], 404)
        self.assertEqual(self.request('/api/redeem', 'POST', 'card=fixture')[2], b'cardgw:POST:/api/redeem')

    def test_commerce_and_legacy_documents_keep_their_own_csp(self):
        for path in ['/user/api/storefront/bootstrap', '/user/captcha/image', '/user/pay/fixture',
                     '/pay/fixture', '/admin/', '/assets/common.js', '/user/personal/index', '/not-a-spa']:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, f'commerce:GET:{path}'.encode())
                self.assertEqual(headers.get('cache-control'), 'no-store')
                self.assertIn("'unsafe-inline'", headers.get('content-security-policy', ''))

    def test_commerce_api_and_cashier_keep_the_existing_body_limit(self):
        for path in ['/user/api/order/trade', '/user/pay/fixture']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path, 'POST', b'x' * (64 * 1024 + 1))[0], 413)

    def test_old_download_links_are_confirmation_only_and_queries_are_not_logged(self):
        marker = 'fixture-secret-not-for-logs'
        status, headers, body = self.request(f'/dl/private/tool.zip?token={marker}')
        self.assertEqual(status, 200)
        self.assertEqual(body, self.shell)
        self.assertEqual(headers.get('cache-control'), 'no-store')
        log = (self.directory / 'logs' / 'download-safe.log').read_text()
        self.assertNotIn(marker, log)
        self.assertEqual(self.request('/dl/')[0], 404)

    def test_private_downloads_and_public_files_have_distinct_cache_boundaries(self):
        status, headers, body = self.request('/p/private/tool.zip?sign=fixture')
        self.assertEqual(body, b'files:GET:/p/private/tool.zip?sign=fixture')
        self.assertEqual(headers.get('cache-control'), 'private, no-store')
        status, headers, body = self.request('/pub/example.zip')
        self.assertEqual(body, b'public fixture')
        self.assertIn('public', headers.get('cache-control', ''))
        status, headers, _ = self.request('/pub/missing.zip')
        self.assertEqual(status, 404)
        self.assertNotIn('public', headers.get('cache-control', ''))

    def test_private_infrastructure_paths_are_not_exposed(self):
        for path in ['/health', '/ready', '/metrics', '/files', '/files/']:
            self.assertEqual(self.request(path)[0], 404, path)

    def test_ambiguous_paths_are_rejected_before_nginx_normalizes_them(self):
        for path in ['/dl/private/../tool.zip', '/dl/private/%2e%2e/tool.zip',
                     '/api/../redeem', '/api/%2e%2e/redeem', '/api//redeem',
                     '//redeem', '/dl/private%2ftool.zip', '/dl/private%5ctool.zip',
                     '/dl/private\\tool.zip']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 400)


if __name__ == '__main__':
    unittest.main()
