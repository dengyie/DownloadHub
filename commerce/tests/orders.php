<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Illuminate\Database\Capsule\Manager as DB;
use Kernel\Database\Bootstrap;
use App\Service\Bind\Order as OrderService;
use App\Service\Bind\Recharge as RechargeService;
use App\Model\Order;
use App\Model\Commodity;
use Kernel\Exception\JSONException;


function hook(...$arguments): void {
    if (($GLOBALS['fail_payment_commit'] ?? false) && $arguments[0] === App\Consts\Hook::USER_API_ORDER_PAY_AFTER) {
        DB::statement('INSERT INTO mail_commit_probe VALUES(999999999)');
    }
    if (($GLOBALS['fail_payment_hook'] ?? false) && $arguments[0] === App\Consts\Hook::USER_API_ORDER_PAY_AFTER) {
        throw new RuntimeException('post-payment-hook-failed');
    }
}
class RecordingEmail extends App\Service\Bind\Email {
    public function send(string $email, string $title, string $content): bool {
        $GLOBALS['delivered_email'][] = $content;
        verify(DB::connection()->transactionLevel() === 0, 'email sent before outer commit');
        return !($GLOBALS['fail_email'] ?? false);
    }
}


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
    // Retained while reproducing the old implementation's early email send.
    if (property_exists($orders, 'email')) {
        $email = new ReflectionProperty($orders, 'email');
        $email->setAccessible(true);
        $email->setValue($orders, new RecordingEmail());
    }
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
    verify(realpath($schema) === realpath(dirname(rtrim(BASE_PATH, '/')) . '/schema.sqlite'), 'schema must belong to this fixture');
    $source = new PDO('sqlite:file:' . $schema . '?mode=ro');
    $target = new PDO('sqlite:' . $testDb);
    $target->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $target->exec('PRAGMA journal_mode=WAL');
    foreach ($source->query("SELECT sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END") as $entry) {
        $target->exec($entry['sql']);
    }
    $source = $target = null;
    connectTest($testDb);
    Kernel\Database\CommerceSchema::upgrade();
    Kernel\Database\CommerceSchema::upgrade(); // additive migration must be repeatable
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

    function concurrentCallbacks(string $db, string $kind, string|array $tradeNo, string $barrier): void {
        $processes = [];
        if (is_file($barrier)) unlink($barrier);
        for ($i = 0; $i < 2; ++$i) {
            $pipes = [];
            $process = proc_open([PHP_BINARY, '-d', 'error_reporting=24575', __FILE__, '--worker', $db, $kind, is_array($tradeNo) ? $tradeNo[$i] : $tradeNo, $barrier], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
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
        verify($results === (is_array($tradeNo) ? ['success', 'success'] : ['rejected:order status error', 'success']), 'concurrent callbacks: ' . json_encode($results));
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
    if (getenv('COMMERCE_REVIEW_CASE') !== 'notification') {
        $short = fixture('order', $orderValues + ['trade_no' => 'stock-exhausted']);
        verify(callbackResult('order', 'stock-exhausted') === 'success', 'paid shortage callback not acknowledged');
        $shortRow = Order::find($short);
        verify($shortRow->status === 1 && $shortRow->delivery_status === 0, 'stock shortage falsely marked delivered');
        verify($shortRow->secret === '' && DB::table('card')->where('order_id', $short)->count() === 0, 'shortage must not contain a delivered secret');
        $beforeBills = DB::table('bill')->count();
        $beforeTotal = DB::table('user')->where('id', $user)->value('recharge');
        verify(!service('order')->retryDelivery($short), 'empty stock retry falsely succeeded');
        $restocked = fixture('card', ['commodity_id' => $commodity, 'secret' => 'restocked', 'race' => 'blue', 'sku' => json_encode(['size' => 'small']), 'status' => 0]);
        verify(service('order')->retryDelivery($short) && service('order')->retryDelivery($short), 'restock/idempotent retry failed');
        verify(Order::find($short)->delivery_status === 1 && DB::table('card')->where('order_id', $short)->count() === 1, 'restock did not assign one card');
        verify(DB::table('bill')->count() === $beforeBills && DB::table('user')->where('id', $user)->value('recharge') == $beforeTotal, 'retry repeated accounting');

        // Two independently paid orders race for the very last matching card.
        $raceValues = array_replace($orderValues, ['race' => 'last', 'sku' => null]);
        fixture('card', ['commodity_id' => $commodity, 'secret' => 'last-card', 'race' => 'last', 'status' => 0]);
        $raceIds = [fixture('order', $raceValues + ['trade_no' => 'last-a']), fixture('order', $raceValues + ['trade_no' => 'last-b'])];
        concurrentCallbacks($testDb, 'order', ['last-a', 'last-b'], $barrier);
        verify(Order::whereIn('id', $raceIds)->where('status', 1)->count() === 2, 'lost an external payment');
        verify(Order::whereIn('id', $raceIds)->where('delivery_status', 1)->count() === 1, 'two orders claimed last stock');
        verify(DB::table('card')->whereIn('order_id', $raceIds)->count() === 1, 'last card allocation incorrect');

        // A sold selected card cannot silently fall back to a different SKU/card.
        $selected = fixture('order', $orderValues + ['trade_no' => 'selected-sold', 'card_id' => $restocked]);
        verify(callbackResult('order', 'selected-sold') === 'success', 'selected shortage payment rejected');
        verify(Order::find($selected)->delivery_status === 0, 'sold selected card marked delivered');
        verify(!service('order')->retryDelivery($selected, $wrongSku), 'wrong SKU accepted as selected replacement');
        verify(Order::find($selected)->card_id === $restocked, 'failed replacement altered selected card');
        $replacement = fixture('card', ['commodity_id' => $commodity, 'secret' => 'replacement', 'race' => 'blue', 'sku' => json_encode(['size' => 'small']), 'status' => 0]);
        verify(service('order')->retryDelivery($selected, $replacement), 'explicit valid selected replacement failed');
        verify(Order::find($selected)->card_id === $replacement, 'replacement assignment not persisted');

        // Same transaction sequence used by balance purchases: debit + settle.
        $balance = App\Model\User::find($user)->getRawOriginal('balance');
        $bills = DB::table('bill')->count();
        $balanceOrder = fixture('order', $orderValues + ['trade_no' => 'balance-shortage']);
        try {
            DB::transaction(function () use ($user, $balanceOrder): void {
                App\Model\Bill::create($user, 0.50, App\Model\Bill::TYPE_SUB, 'test balance purchase');
                service('order')->orderSuccess(Order::find($balanceOrder));
            });
            throw new RuntimeException('balance shortage was accepted');
        } catch (JSONException $expected) { verify(str_contains($expected->getMessage(), '库存不足'), 'unexpected balance failure'); }
        verify(App\Model\User::find($user)->getRawOriginal('balance') == $balance && DB::table('bill')->count() === $bills, 'stock shortage kept balance deduction');
        verify(Order::find($balanceOrder)->status === 0, 'balance shortage marked paid');

    }
    if (getenv('COMMERCE_REVIEW_CASE') !== 'stock') {
        $mailCommodity = fixture('commodity', ['name' => 'Mail', 'code' => 'mail', 'delivery_way' => 0, 'contact_type' => 2, 'send_email' => 1]);
        $mailCard = fixture('card', ['commodity_id' => $mailCommodity, 'secret' => 'mail-card', 'status' => 0]);
        $mailOrder = fixture('order', array_replace($orderValues, ['commodity_id' => $mailCommodity, 'trade_no' => 'mail-hook', 'owner' => 0, 'contact' => 'recipient@example.invalid', 'race' => null, 'sku' => null]));
        $GLOBALS['fail_payment_hook'] = true;
        try {
            callbackResult('order', 'mail-hook');
            throw new RuntimeException('hook failure not propagated');
        } catch (RuntimeException $failure) {
            verify($failure->getMessage() === 'post-payment-hook-failed', 'original hook failure lost');
        } finally { $GLOBALS['fail_payment_hook'] = false; }
        verify(count($GLOBALS['delivered_email'] ?? []) === 0, 'email escaped a rolled-back order');
        verify(Order::find($mailOrder)->status === 0 && DB::table('card')->where('id', $mailCard)->value('status') == 0, 'hook failure persisted business changes');
        verify(DB::table('order_notification')->count() === 0, 'rolled-back notification remained queued');
        DB::statement('CREATE TABLE mail_commit_probe (user_id INTEGER REFERENCES acg_user(id) DEFERRABLE INITIALLY DEFERRED)');
        $GLOBALS['fail_payment_commit'] = true;
        try {
            callbackResult('order', 'mail-hook');
            throw new RuntimeException('commit failure was accepted');
        } catch (PDOException $expected) {} finally { $GLOBALS['fail_payment_commit'] = false; }
        verify(count($GLOBALS['delivered_email'] ?? []) === 0 && DB::table('order_notification')->count() === 0, 'commit failure leaked notification');
        verify(Order::find($mailOrder)->status === 0, 'commit failure marked paid');
        DB::statement('DROP TABLE mail_commit_probe');
        verify(callbackResult('order', 'mail-hook') === 'success', 'mail order payment failed');
        verify(count($GLOBALS['delivered_email'] ?? []) === 0 && DB::table('order_notification')->count() === 1, 'mail must be queued rather than sent in request');
        $mailBills = DB::table('bill')->count();
        $GLOBALS['fail_email'] = true;
        $failed = App\Service\Bind\OrderNotification::dispatch(new RecordingEmail());
        verify($failed === ['sent' => 0, 'failed' => 1], 'mail failure not recorded');
        verify(App\Service\Bind\OrderNotification::dispatch(new RecordingEmail()) === ['sent' => 0, 'failed' => 0], 'retry ignored backoff');
        $GLOBALS['fail_email'] = false;
        DB::table('order_notification')->update(['available_at' => 0]);
        // Another active worker's lease excludes this sender.
        DB::table('order_notification')->update(['lease_until' => time() + 300, 'lease_token' => 'another-worker']);
        verify(App\Service\Bind\OrderNotification::dispatch(new RecordingEmail()) === ['sent' => 0, 'failed' => 0], 'active notification lease ignored');
        DB::table('order_notification')->update(['lease_until' => 0]);
        verify(App\Service\Bind\OrderNotification::dispatch(new RecordingEmail()) === ['sent' => 1, 'failed' => 0], 'failed/crashed notification not recovered');
        verify(App\Service\Bind\OrderNotification::dispatch(new RecordingEmail()) === ['sent' => 0, 'failed' => 0], 'sent notification dispatched twice');
        verify(DB::table('bill')->count() === $mailBills && DB::table('card')->where('order_id', $mailOrder)->count() === 1, 'mail retry repeated settlement');
        verify(count($GLOBALS['delivered_email']) === 2 && $GLOBALS['delivered_email'][0] === $GLOBALS['delivered_email'][1], 'retry sent a different card');
        try {
            DB::transaction(static function (): void { App\Service\Bind\OrderNotification::dispatch(new RecordingEmail()); });
            throw new RuntimeException('nested email dispatch allowed');
        } catch (LogicException $expected) {}

    }
    // Exercise the shipped CLI in a separate PHP process at the worker's 64 MiB limit.
    // The fixture contains no SMTP configuration or customer data; all notices are already sent.
    verify(DB::table('order_notification')->whereNull('sent_at')->count() === 0, 'CLI test would encounter an outbound notice');
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($overlay, FilesystemIterator::SKIP_DOTS)) as $sourceFile) {
        if (!$sourceFile->isFile()) continue;
        $destination = BASE_PATH . substr($sourceFile->getPathname(), strlen($overlay) + 1);
        if (!is_dir(dirname($destination))) mkdir(dirname($destination), 0700, true);
        copy($sourceFile->getPathname(), $destination);
    }
    mkdir(BASE_PATH . 'config', 0700);
    file_put_contents(BASE_PATH . 'config/database.php', '<?php return ' . var_export(['driver' => 'sqlite', 'database' => $testDb, 'prefix' => 'acg_'], true) . ';');
    if (!is_dir(BASE_PATH . 'kernel/Install')) mkdir(BASE_PATH . 'kernel/Install', 0700, true);
    file_put_contents(BASE_PATH . 'kernel/Install/Lock', 'fixture-only');
    try {
        $cliOrder = fixture('order', array_replace($orderValues, ['trade_no' => 'cli-pending', 'race' => 'cli', 'sku' => null]));
        verify(callbackResult('order', 'cli-pending') === 'success', 'CLI fixture payment failed');
        fixture('card', ['commodity_id' => $commodity, 'secret' => 'cli-card', 'race' => 'cli', 'status' => 0]);
        $beforeCLI = DB::table('bill')->count();
        foreach (['--migrate', '--once'] as $mode) {
            $pipes = [];
            $process = proc_open([PHP_BINARY, '-d', 'memory_limit=64M', BASE_PATH . 'bin/commerce-maintenance.php', $mode], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            verify(is_resource($process), 'CLI process did not start');
            fclose($pipes[0]);
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]); fclose($pipes[2]);
            verify(proc_close($process) === 0, 'CLI failed: ' . $errors . ' ' . $output);
            if ($mode === '--once') verify(is_array(json_decode($output, true)), 'CLI did not report batch counters');
        }
        verify(DB::table('bill')->count() === $beforeCLI, 'maintenance repeated payment accounting');
        verify(Order::find($cliOrder)->delivery_status === 1, 'CLI did not fulfill the restocked paid order');
    } finally {
        unlink(BASE_PATH . 'config/database.php');
        rmdir(BASE_PATH . 'config');
    }
    verify((string)DB::selectOne('PRAGMA integrity_check')->integrity_check === 'ok', 'integrity check failed');
    echo "PASS: shortage/restock/selected replacement/balance rollback/competing orders/outbox hook+commit failure/backoff+lease recovery; real migrated schema; random inventory + JSON SKU/race; amount rejection; repeated/concurrent order & recharge callbacks; referral/fee accounting; inventory write failure rollback\n";
} finally {
    DB::connection()->disconnect();
    foreach ([$testDb, $testDb . '-wal', $testDb . '-shm', $barrier] as $file) if (is_file($file)) unlink($file);
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($plugin, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($files as $entry) $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    rmdir($plugin);
}
