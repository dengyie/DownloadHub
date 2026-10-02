<?php
declare(strict_types=1);

// Runs solely against a disposable SQLite file; production configuration is never loaded.
require getenv('COMMERCE_VENDOR_AUTOLOAD') ?: '/var/www/html/vendor/autoload.php';
$overlay = dirname(__DIR__) . '/overlay';
spl_autoload_register(static function (string $class) use ($overlay): void {
    $prefixes = ['Kernel\\' => 'kernel/', 'App\\' => 'app/'];
    foreach ($prefixes as $prefix => $directory) {
        if (str_starts_with($class, $prefix)) {
            $file = $overlay . '/' . $directory . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            if (is_file($file)) {
                require $file;
            }
            return;
        }
    }
}, true, true);

use App\Model\Bill;
use App\Model\User;
use Illuminate\Database\Capsule\Manager as DB;
use Kernel\Database\Bootstrap;
use Kernel\Exception\JSONException;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
function rejects(callable $operation, string $message): void
{
    try {
        $operation();
    } catch (JSONException $expected) {
        return;
    }
    throw new RuntimeException($message);
}
function money(int $id, string $field = 'balance'): string
{
    return number_format((float)DB::table('user')->where('id', $id)->value($field), 2, '.', '');
}
$file = tempnam(sys_get_temp_dir(), 'commerce-bill-');
try {
    $provision = new PDO('sqlite:' . $file);
    $provision->exec('PRAGMA journal_mode=WAL');
    $provision = null;
    Bootstrap::boot(['driver' => 'sqlite', 'database' => $file, 'prefix' => '', 'busy_timeout' => 1000]);
    DB::statement('CREATE TABLE user (id INTEGER PRIMARY KEY, balance NUMERIC NOT NULL DEFAULT 0, coin NUMERIC NOT NULL DEFAULT 0, recharge NUMERIC NOT NULL DEFAULT 0, total_coin NUMERIC NOT NULL DEFAULT 0)');
    DB::statement('CREATE TABLE bill (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, amount NUMERIC NOT NULL, balance NUMERIC NOT NULL, currency INTEGER NOT NULL, type INTEGER NOT NULL, log TEXT NOT NULL CHECK(log != \'fail-insert\'), create_time TEXT NOT NULL)');
    DB::table('user')->insert(['id' => 1, 'balance' => '0.30']);
    DB::table('user')->insert(['id' => 2, 'balance' => '10.00', 'coin' => '5.00']);

    // A snapshot taken before another completed credit must not clobber that credit.
    $stale = User::find(2);
    Bill::create(2, 3.00, Bill::TYPE_ADD, 'credit', 0, false);
    Bill::create($stale, 1.00, Bill::TYPE_SUB, 'stale debit');
    check(money(2) === '12.00', 'stale model overwrote newer balance');
    check(number_format($stale->balance, 2, '.', '') === '12.00' && !$stale->isDirty('balance'), 'caller model not synchronized');

    Bill::create(1, .10, Bill::TYPE_SUB, 'decimal debit');
    Bill::create(1, .20, Bill::TYPE_SUB, 'exact exhaustion');
    check(money(1) === '0.00', 'decimal residual after exact exhaustion');
    rejects(fn () => Bill::create(1, .01, Bill::TYPE_SUB, 'overdraw'), 'overdraft accepted');

    DB::transaction(static function () use ($stale): void {
        Bill::create($stale, .10, Bill::TYPE_ADD, 'nested first');
        Bill::create($stale, .20, Bill::TYPE_ADD, 'nested second');
    });
    check(money(2) === '12.30' && money(2, 'recharge') === '0.30', 'nested credits lost balance or cumulative total');
    $beforeCount = DB::table('bill')->count();
    try {
        DB::transaction(static function (): void {
            Bill::create(2, 1.00, Bill::TYPE_SUB, 'outer rollback');
            throw new RuntimeException('rollback marker');
        });
    } catch (RuntimeException $error) {
        check($error->getMessage() === 'rollback marker', 'unexpected outer transaction error');
    }
    check(money(2) === '12.30' && DB::table('bill')->count() === $beforeCount, 'outer rollback leaked writes');

    // Ledger failure must also undo the earlier User save.
    try {
        Bill::create(2, 2.00, Bill::TYPE_ADD, 'fail-insert');
        throw new RuntimeException('injected ledger failure was ignored');
    } catch (Illuminate\Database\QueryException $expected) {
    }
    check(money(2) === '12.30' && money(2, 'recharge') === '0.30' && DB::table('bill')->count() === $beforeCount, 'failed ledger insert left partial credit');

    // Failed nested operation rolls back its savepoint, not the surrounding transaction.
    DB::transaction(static function (): void {
        Bill::create(2, 1.00, Bill::TYPE_ADD, 'survives', 1, false);
        rejects(fn () => Bill::create(2, 100.00, Bill::TYPE_SUB, 'nested insufficient', 1), 'nested overdraft accepted');
        Bill::create(2, 2.00, Bill::TYPE_SUB, 'coin debit', 1);
    });
    check(money(2, 'coin') === '4.00' && money(2, 'total_coin') === '0.00', 'nested rejection rolled back successful sibling or changed total');

    foreach ([0.0, -1.0, INF, NAN, .001, 1.234, 100000000.0] as $invalid) {
        rejects(fn () => Bill::create(2, $invalid, Bill::TYPE_ADD, 'invalid'), 'invalid amount accepted');
    }
    rejects(fn () => Bill::create(2, 1, 2, 'invalid type'), 'invalid type accepted');
    rejects(fn () => Bill::create(2, 1, 1, 'invalid currency', 2), 'invalid currency accepted');
    rejects(fn () => Bill::create(999, 1, 1, 'missing user'), 'missing user accepted');
    Bill::create(1, .1 + .2, Bill::TYPE_ADD, 'floating arithmetic input', 0, false);
    check(money(1) === '0.30', 'binary floating noise was rejected or persisted');
    for ($i = 0; $i < 20; ++$i) {
        Bill::create(1, .01, Bill::TYPE_ADD, 'small credit', 0, false);
        Bill::create(1, .01, Bill::TYPE_SUB, 'small debit');
    }
    check(money(1) === '0.30', 'repeated small operations drifted');
    DB::table('user')->insert(['id' => 3, 'balance' => '999999999999.99']);
    rejects(fn () => Bill::create(3, .01, 1, 'overflow'), 'balance overflow accepted');
    check(money(3) === '999999999999.99', 'overflow changed balance');
    check((string)DB::selectOne('PRAGMA integrity_check')->integrity_check === 'ok', 'integrity check failed');
    echo "PASS: stale model, decimal exhaustion, nested credits/rollback, atomic ledger, invalid amounts, currencies, overflow, repeated cents\n";
} finally {
    DB::connection()->disconnect();
    foreach ([$file, $file . '-wal', $file . '-shm'] as $path) {
        if (is_file($path)) {
            unlink($path);
        }
    }
}
