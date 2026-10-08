<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use App\Util\CaptchaStore;

$assertions = 0;
function check(bool $condition, string $message = 'captcha assertion'): void
{
    global $assertions;
    $assertions++;
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$db = new PDO('sqlite::memory:');
$store = new CaptchaStore($db);
$first = $store->issue('login', '192.0.2.1', 1000);
$second = $store->issue('login', '192.0.2.1', 1000);
check($first['id'] !== $second['id'], 'each displayed image must have its own identity');
check((bool)preg_match('/^[A-Za-z0-9_-]{22}$/D', $first['id']), '128-bit opaque ID');
check((bool)preg_match('/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/D', $first['code']), 'unambiguous four-character alphabet');
check($store->consume($first['id'], strtolower($first['code']), 'login', '192.0.2.1', 1001), 'first correct image remains valid after refreshing in another tab');
check($store->consume($second['id'], ' ' . $second['code'] . ' ', 'login', '192.0.2.1', 1001), 'second image remains independently valid');
check(!$store->consume($first['id'], $first['code'], 'login', '192.0.2.1', 1001), 'success cannot be replayed');

$challenge = $store->issue('register', '192.0.2.1', 1002);
check(!$store->consume($challenge['id'], $challenge['code'], 'login', '192.0.2.1', 1003), 'scene isolation');
check(!$store->consume($challenge['id'], $challenge['code'], 'register', '192.0.2.2', 1003), 'client isolation');
check($store->consume($challenge['id'], $challenge['code'], 'register', '192.0.2.1', 1301), 'last valid second');
$expired = $store->issue('login', '192.0.2.1', 1000);
check(!$store->consume($expired['id'], $expired['code'], 'login', '192.0.2.1', 1300), '300-second expiry is exclusive');

$wrong = $store->issue('trade', '192.0.2.1', 1301);
$wrongCode = $wrong['code'] === 'AAAA' ? 'BBBB' : 'AAAA';
check(!$store->consume($wrong['id'], $wrongCode, 'trade', '192.0.2.1', 1302), 'wrong answer rejected');
check(!$store->consume($wrong['id'], $wrong['code'], 'trade', '192.0.2.1', 1302), 'wrong answer consumes challenge, preventing repeated guesses');
foreach ([[null, null], [[], 'AAAA'], ['../../file', 'AAAA'], [str_repeat('a', 22), []], [str_repeat('a', 22), 1234]] as [$id, $code]) {
    check(!$store->consume($id, $code, 'login', '192.0.2.1', 1302), 'malformed fields fail closed without conversion warnings');
}

foreach (CaptchaStore::SCENES as $scene) {
    $item = $store->issue($scene, '192.0.2.3', 2000);
    check($store->consume($item['id'], $item['code'], $scene, '192.0.2.3', 2001), 'supported scene ' . $scene);
}
foreach ([['unknown', '192.0.2.1'], ['login', ''], ['login', 'invalid-address']] as [$scene, $ip]) {
    try {
        $store->issue($scene, $ip, 2000);
        check(false, 'invalid issue arguments accepted');
    } catch (InvalidArgumentException) {
        check(true);
    }
}

$limited = new CaptchaStore(new PDO('sqlite::memory:'));
for ($i = 0; $i < 60; $i++) {
    $item = $limited->issue('login', '192.0.2.9', 3000);
    check($limited->consume($item['id'], $item['code'], 'login', '192.0.2.9', 3000));
}
try {
    $limited->issue('register', '192.0.2.9', 3001);
    check(false, 'consumption must not reset the per-IP generation budget');
} catch (OverflowException) {
    check(true);
}
$limited->issue('login', '192.0.2.10', 3001);
$limited->issue('login', '192.0.2.9', 3300);
check(true, 'independent IP and expired budget can issue');

$boundedDB = new PDO('sqlite::memory:');
$bounded = new CaptchaStore($boundedDB);
$boundedDB->exec('BEGIN');
$insert = $boundedDB->prepare('INSERT INTO challenges VALUES (?, ?, ?, NULL, ?)');
for ($i = 0; $i < 10000; $i++) $insert->execute(['fixture-' . $i, 'login', 'fixture-ip-' . $i, 5000]);
$boundedDB->exec('COMMIT');
try {
    $bounded->issue('login', '192.0.2.100', 4999);
    check(false, 'global live challenge budget must be bounded');
} catch (OverflowException) {
    check(true);
}
$bounded->issue('login', '192.0.2.100', 5000);
check((int)$boundedDB->query('SELECT COUNT(*) FROM challenges')->fetchColumn() === 1, 'expired rows reclaim bounded capacity');

$private = CaptchaStore::open();
$directory = realpath(sys_get_temp_dir()) . '/cardgw-captcha-' . substr(hash('sha256', realpath(BASE_PATH)), 0, 20);
check((fileperms($directory) & 0777) === 0700, 'captcha directory must be owner-only');
check((fileperms($directory . '/challenges.sqlite') & 0777) === 0600, 'captcha database must be owner-only');
check(!str_starts_with($directory, rtrim(BASE_PATH, '/') . '/'), 'ephemeral captcha database stays outside document root');

// Match the deployed chain: nginx overwrites X-Real-IP; PHP trusts only loopback.
// A missing client mode makes every visitor share the proxy's generation budget.
if (!is_dir(BASE_PATH . '/runtime')) mkdir(BASE_PATH . '/runtime', 0700);
\App\Util\Client::setTrustedProxyConfig("127.0.0.1\n::1");
\App\Util\Client::setClientMode(1);
$_SERVER = ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_REAL_IP' => '192.0.2.21',
    'HTTP_X_FORWARDED_FOR' => '203.0.113.9', 'HTTP_CF_CONNECTING_IP' => '203.0.113.8'];
check(\App\Util\Client::getAddress() === '192.0.2.21', 'trusted proxy uses only its overwritten client header');
$proxied = new CaptchaStore(new PDO('sqlite::memory:'));
$proxyChallenge = $proxied->issue('login', \App\Util\Client::getAddress());
$_SERVER['HTTP_X_REAL_IP'] = '192.0.2.22';
check(\App\Util\Client::getAddress() === '192.0.2.22', 'different visitors retain independent identities');
check(!$proxied->consume($proxyChallenge['id'], $proxyChallenge['code'], 'login', \App\Util\Client::getAddress()), 'another proxied client cannot consume the image');
$_SERVER['HTTP_X_REAL_IP'] = '192.0.2.21';
check($proxied->consume($proxyChallenge['id'], $proxyChallenge['code'], 'login', \App\Util\Client::getAddress()), 'issuing visitor can still use the image');
$_SERVER['REMOTE_ADDR'] = '::1';
check(\App\Util\Client::getAddress() === '192.0.2.21', 'IPv6 loopback proxy is explicit');
$_SERVER['REMOTE_ADDR'] = '198.51.100.4';
check(\App\Util\Client::getAddress() === '198.51.100.4', 'untrusted peer cannot forge a client address');

// Different PHP processes must share one challenge and cannot both consume it.
$path = tempnam(sys_get_temp_dir(), 'captcha-race-');
$shared = new CaptchaStore(new PDO('sqlite:' . $path));
$race = $shared->issue('login', '192.0.2.11');
$children = [];
for ($i = 0; $i < 2; $i++) {
    $program = 'require ' . var_export(__DIR__ . '/bootstrap.php', true) . ';'
        . '$s=new App\\Util\\CaptchaStore(new PDO(' . var_export('sqlite:' . $path, true) . '));'
        . 'echo $s->consume(' . var_export($race['id'], true) . ',' . var_export($race['code'], true)
        . ',"login","192.0.2.11") ? "1" : "0";';
    $process = proc_open([PHP_BINARY, '-r', $program], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot start race worker');
    $children[] = [$process, $pipes];
}
$results = [];
foreach ($children as [$process, $pipes]) {
    $results[] = stream_get_contents($pipes[1]);
    $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    check(proc_close($process) === 0, 'race worker failed: ' . $error);
}
sort($results);
check($results === ['0', '1'], 'exactly one concurrent verification succeeds');

echo "PASS captcha lifecycle ({$assertions} assertions)\n";
