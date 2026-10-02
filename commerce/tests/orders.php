<?php
declare(strict_types=1);

// Real schema and application services; all writes target a new disposable DB.
// Only the payment provider and outbound hook are fixtures. Never load production config.
$app = getenv('COMMERCE_TEST_APP') ?: '/tmp/sqlite-app';
if (!str_starts_with(realpath($app) ?: '', '/tmp/')) {
    throw new RuntimeException('Application fixture must be isolated below /tmp');
}
define('BASE_PATH', rtrim($app, '/') . '/');
require BASE_PATH . 'vendor/autoload.php';
$overlay = dirname(__DIR__) . '/overlay';
spl_autoload_register(static function (string $class) use ($overlay): void {
    foreach (['Kernel\\' => 'kernel/', 'App\\' => 'app/'] as $prefix => $directory) {
        if (str_starts_with($class, $prefix)) {
            $relative = $directory . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            foreach ([$overlay . '/', BASE_PATH] as $root) {
                if (is_file($root . $relative)) {
                    require $root . $relative;
                    return;
                }
            }
        }
    }
}, true, true);
function hook(...$arguments): void {}

use Illuminate\Database\Capsule\Manager as DB;
use Kernel\Database\Bootstrap;
use App\Service\Bind\Order as OrderService;
use App\Service\Bind\Recharge as RechargeService;
use App\Model\Order;
use App\Model\Commodity;
use Kernel\Exception\JSONException;

function verify(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
function fixture(string $table, array $values): int {
    $defaults = [];
    foreach (DB::select('PRAGMA table_info("acg_' . $table . '")') as $column) {
        if ($column->notnull && $column->dflt_value === null && !$column->pk) {
            $defaults[$column->name] = in_array($column->type, ['INTEGER', 'NUMERIC', 'REAL'], true) ? 0 : 'x';
        }
    }
    return (int)DB::table($table)->insertGetId(array_replace($defaults, $values));
}
function service(string $kind): OrderService|RechargeService {
    $orders = new OrderService();
    if ($kind === 'order') return $orders;
    $recharge = new RechargeService();
    $property = new ReflectionProperty($recharge, 'order');
    $property->setAccessible(true);
    $property->setValue($recharge, $orders);
    return $recharge;
}
function payload(string $tradeNo, string $amount = '1.00'): array {
    return ['trade_no' => $tradeNo, 'amount' => $amount, 'sign' => hash_hmac('sha256', $tradeNo . ':' . $amount, 'sqlite-test-only')];
}
function callbackResult(string $kind, string $tradeNo, string $amount = '1.00'): string {
    try {
        return service($kind)->callback('SqliteFixture', payload($tradeNo, $amount));
    } catch (JSONException $expected) {
        return 'rejected:' . $expected->getMessage();
    }
}
function connectTest(string $file): void {
    verify(str_starts_with($file, '/tmp/commerce-orders-'), 'test database path guard');
    Bootstrap::boot(['driver' => 'sqlite', 'database' => $file, 'prefix' => 'acg_', 'busy_timeout' => 5000]);
    App\Util\Context::set('_DB_CONFIG_recharge_welfare', '0');
}
if (($argv[1] ?? '') === '--worker') {
    connectTest($argv[2]);
    $barrier = $argv[5];
    $deadline = microtime(true) + 10;
    while (!is_file($barrier)) {
        if (microtime(true) > $deadline) throw new RuntimeException('barrier timeout');
        usleep(10000);
    }
    echo callbackResult($argv[3], $argv[4]) . "\n";
    exit;
}

$plugin = BASE_PATH . 'app/Pay/SqliteFixture';
verify(!file_exists($plugin), 'fixture plugin already exists; refusing to overwrite');
mkdir($plugin . '/Config', 0700, true);
mkdir($plugin . '/Impl', 0700, true);
file_put_contents($plugin . '/Impl/Pay.php', "<?php // Test-only callback provider marker.\n");
file_put_contents($plugin . '/Config/Config.php', "<?php return ['secret' => 'sqlite-test-only'];\n");
file_put_contents($plugin . '/Config/Info.php', "<?php return ['callback' => [1=>true, 4=>false, 5=>'trade_no', 6=>'amount', 7=>'success']];\n");
file_put_contents($plugin . '/Impl/Signature.php', <<<'SIGNATURE'
<?php
namespace App\Pay\SqliteFixture\Impl;
class Signature {
    public function verification(array $map, array $config): bool {
        return hash_equals(hash_hmac('sha256', $map['trade_no'] . ':' . $map['amount'], $config['secret']), $map['sign'] ?? '');
    }
}
SIGNATURE);
$testDb = tempnam('/tmp', 'commerce-orders-');
$barrier = $testDb . '.start';
try {
    $schema = getenv('COMMERCE_SCHEMA_DB') ?: throw new RuntimeException('COMMERCE_SCHEMA_DB must name the final migrated schema');
    verify(str_starts_with(realpath($schema) ?: '', '/tmp/'), 'schema fixture must be below /tmp');
    $source = new PDO('sqlite:file:' . $schema . '?mode=ro');
    $target = new PDO('sqlite:' . $testDb);
    $target->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $target->exec('PRAGMA journal_mode=WAL');
    foreach ($source->query("SELECT sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END") as $entry) {
        $target->exec($entry['sql']);
    }
    $source = $target = null;
    connectTest($testDb);
    $user = fixture('user', ['username' => 'sqlite-buyer', 'email' => 'buyer@example.invalid', 'balance' => '0.00', 'recharge' => '0.00']);
    $referrer = fixture('user', ['username' => 'sqlite-referrer', 'email' => 'referrer@example.invalid']);
    $pay = fixture('pay', ['name' => 'Fixture', 'handle' => 'SqliteFixture', 'code' => 'fixture']);
    $commodity = fixture('commodity', ['name' => 'Fixture', 'code' => 'fixture', 'delivery_way' => 0, 'delivery_auto_mode' => 1, 'shared_id' => null, 'send_email' => 0]);
    $orderValues = ['commodity_id' => $commodity, 'pay_id' => $pay, 'amount' => '1.00', 'owner' => $user, 'status' => 0, 'card_num' => 1, 'user_id' => 0, 'from' => $referrer, 'divide_amount' => '0.10', 'rebate' => '0.00', 'race' => 'blue', 'sku' => json_encode(['size' => 'small'])];
    fixture('card', ['commodity_id' => $commodity, 'secret' => 'matching-card', 'race' => 'blue', 'sku' => json_encode(['size' => 'small']), 'status' => 0]);
    $wrongSku = fixture('card', ['commodity_id' => $commodity, 'secret' => 'wrong-sku', 'race' => 'blue', 'sku' => json_encode(['size' => 'large']), 'status' => 0]);
    fixture('card', ['commodity_id' => $commodity, 'secret' => 'wrong-race', 'race' => 'red', 'sku' => json_encode(['size' => 'small']), 'status' => 0]);
    $orderId = fixture('order', $orderValues + ['trade_no' => 'sequential']);
    verify(callbackResult('order', 'sequential', '1.01') === 'rejected:amount error', 'wrong amount accepted');
    verify(DB::table('card')->where('status', 1)->count() === 0, 'wrong amount consumed inventory');
    verify(callbackResult('order', 'sequential') === 'success', 'valid callback failed');
    verify(callbackResult('order', 'sequential') === 'rejected:order status error', 'repeat callback accepted');
    verify(DB::table('order')->where('id', $orderId)->value('secret') === 'matching-card', 'random/JSON/race query selected wrong card');
    verify(DB::table('card')->where('id', $wrongSku)->value('status') == 0, 'unmatched SKU consumed');
    verify(DB::table('bill')->where('owner', $referrer)->count() === 1, 'duplicate callback credited referral twice');
    verify((float)DB::table('user')->where('id', $user)->value('recharge') === 1.0, 'duplicate callback increased total twice');

    // A database inventory write error must roll back order, owner total and ledger.
    fixture('card', ['commodity_id' => $commodity, 'secret' => 'rollback-card', 'race' => 'blue', 'sku' => json_encode(['size' => 'small']), 'status' => 0]);
    $rollbackOrder = fixture('order', $orderValues + ['trade_no' => 'rollback']);
    DB::unprepared("CREATE TRIGGER reject_test_inventory BEFORE UPDATE ON acg_card BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    try {
        callbackResult('order', 'rollback');
        throw new RuntimeException('inventory write error was swallowed');
    } catch (Illuminate\Database\QueryException $expected) {}
    DB::unprepared('DROP TRIGGER reject_test_inventory');
    verify(DB::table('order')->where('id', $rollbackOrder)->value('status') == 0, 'inventory failure committed paid order');
    verify(DB::table('bill')->count() === 1 && (float)DB::table('user')->where('id', $user)->value('recharge') === 1.0, 'inventory failure leaked accounting writes');

    function concurrentCallbacks(string $db, string $kind, string $tradeNo, string $barrier): void {
        $processes = [];
        if (is_file($barrier)) unlink($barrier);
        for ($i = 0; $i < 2; ++$i) {
            $pipes = [];
            $process = proc_open([PHP_BINARY, '-d', 'error_reporting=24575', __FILE__, '--worker', $db, $kind, $tradeNo, $barrier], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            verify(is_resource($process), 'worker failed to start');
            fclose($pipes[0]);
            $processes[] = [$process, $pipes];
        }
        touch($barrier);
        $results = [];
        foreach ($processes as [$process, $pipes]) {
            $output = trim(stream_get_contents($pipes[1]));
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]); fclose($pipes[2]);
            verify(proc_close($process) === 0, 'callback worker failed: ' . $errors . ' ' . $output);
            $results[] = $output;
        }
        sort($results);
        verify($results === ['rejected:order status error', 'success'], 'concurrent callbacks: ' . json_encode($results));
    }
    concurrentCallbacks($testDb, 'order', 'rollback', $barrier);
    verify(DB::table('card')->where('order_id', $rollbackOrder)->where('status', 1)->count() === 1, 'concurrent callback consumed more than one card');
    verify(DB::table('bill')->where('owner', $referrer)->count() === 2, 'concurrent callback duplicate referral credit');

    fixture('user_recharge', ['trade_no' => 'recharge-concurrent', 'user_id' => $user, 'amount' => '1.00', 'pay_cost' => '0.10', 'pay_id' => $pay, 'status' => 0]);
    verify(callbackResult('recharge', 'recharge-concurrent', '1.001') === 'rejected:amount error', 'recharge overprecision accepted');
    concurrentCallbacks($testDb, 'recharge', 'recharge-concurrent', $barrier);
    verify(number_format((float)DB::table('user')->where('id', $user)->value('balance'), 2, '.', '') === '0.90', 'recharge credit or fee wrong');
    verify(DB::table('bill')->where('owner', $user)->count() === 1, 'concurrent recharge created duplicate ledger');
    verify(callbackResult('recharge', 'recharge-concurrent') === 'rejected:order status error', 'sequential recharge duplicated credit');
    verify(callbackResult('order', 'missing') === 'rejected:pay not found', 'missing order not handled');
    verify((string)DB::selectOne('PRAGMA integrity_check')->integrity_check === 'ok', 'integrity check failed');
    echo "PASS: real migrated schema; random inventory + JSON SKU/race; amount rejection; repeated/concurrent order & recharge callbacks; referral/fee accounting; inventory write failure rollback\n";
} finally {
    DB::connection()->disconnect();
    foreach ([$testDb, $testDb . '-wal', $testDb . '-shm', $barrier] as $file) if (is_file($file)) unlink($file);
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($plugin, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($files as $entry) $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    rmdir($plugin);
}
