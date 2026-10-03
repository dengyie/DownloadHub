<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
use Kernel\Database\Bootstrap;
use Kernel\Database\ImmediatePDO;
use Kernel\Database\PaymentAmount;
function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
if (($argv[1] ?? '') === 'contend') {
    $capsule = Bootstrap::boot(['driver'=>'sqlite','database'=>$argv[2], 'busy_timeout'=>150]);
    $called = false;
    try {
        $capsule->getConnection()->transaction(function () use (&$called) { $called = true; });
        exit(2);
    } catch (PDOException $e) {
        check(!$called, 'busy transaction must fail before callback side effects');
        check(!$capsule->getConnection()->getPdo()->inTransaction(), 'failed BEGIN state');
        check(str_contains($e->getMessage(), 'locked'), 'expected lock error');
        echo "contended before callback\n";
        exit(0);
    }
}
/** A disk-full statement makes SQLite roll back the whole transaction itself. */
function verifyAutomaticRollback(string $scenario): void
{
    $file = tempnam(sys_get_temp_dir(), 'commerce-full-');
    try {
        $observer = new PDO('sqlite:' . $file);
        $observer->exec('PRAGMA page_size=512; PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT)');
        if (in_array($scenario, ['trigger-rollback', 'full-with-trigger'], true)) {
            $observer->exec("CREATE TRIGGER abort_record BEFORE INSERT ON records WHEN NEW.value='abort' BEGIN SELECT RAISE(ROLLBACK, 'forced trigger rollback'); END");
        }
        $connection = Bootstrap::boot(['driver'=>'sqlite', 'database'=>$file])->getConnection();
        $oldPdo = $connection->getPdo();
        $pages = (int)$connection->selectOne('PRAGMA page_count')->page_count;
        $connection->statement('PRAGMA max_page_count=' . $pages);
        $fail = static function () use ($connection, $scenario): void {
            if ($scenario === 'trigger-rollback') {
                $connection->statement("INSERT INTO records(value) VALUES('abort')");
            } elseif ($scenario === 'conflict-rollback') {
                $connection->statement("INSERT OR ROLLBACK INTO records(id,value) VALUES(1,'duplicate')");
            } else {
                $connection->statement('INSERT INTO records(value) VALUES(zeroblob(20000))');
            }
        };
        $caught = null;
        try {
            if (str_starts_with($scenario, 'manual')) {
                $connection->beginTransaction();
                $connection->table('records')->insert(['id'=>1, 'value'=>'before']);
                $fail();
            } else {
                $connection->transaction(static function () use ($connection, $scenario, $fail): void {
                    $connection->table('records')->insert(['id'=>1, 'value'=>'before']);
                    if (in_array($scenario, ['nested', 'nested-caught', 'nested-swallowed'], true)) {
                        try {
                            $connection->transaction($fail);
                        } catch (PDOException $error) {
                            if ($scenario === 'nested') { throw $error; }
                            if ($scenario === 'nested-swallowed') { return; }
                            // Catching a failed savepoint must never allow an outer
                            // callback to write outside its already-aborted transaction.
                            $connection->table('records')->insert(['value'=>'escaped']);
                        }
                    } elseif ($scenario === 'query-caught') {
                        try { $fail(); } catch (PDOException $ignored) {}
                        $connection->table('records')->insert(['value'=>'escaped']);
                    } else {
                        $fail();
                    }
                }, 3); // Retrying callbacks could repeat non-database side effects.
            }
        } catch (PDOException $error) { $caught = $error; }
        check($caught !== null, $scenario . ': failure must propagate');
        check((int)($caught->errorInfo[1] ?? 0) === (in_array($scenario, ['conflict-rollback', 'trigger-rollback'], true) ? 19 : 13), $scenario . ': preserve original SQLite error: ' . $caught->getMessage());
        check($connection->transactionLevel() === 0, $scenario . ': reset framework nesting');
        check(!$oldPdo->inTransaction(), $scenario . ': discard transaction state');
        if (str_starts_with($scenario, 'manual')) {
            try { $connection->table('records')->insert(['value'=>'escaped']); check(false, 'manual failed transaction must block writes'); }
            catch (PDOException $error) { check($error === $caught, 'manual failure remains original'); }
            if ($scenario === 'manual-commit') {
                try { $connection->commit(); check(false, 'failed manual commit must throw'); }
                catch (PDOException $error) { check($error === $caught, 'commit preserves original failure'); }
            } else {
                $connection->rollBack();
            }
        }
        check((int)$observer->query('SELECT count(*) FROM records')->fetchColumn() === 0, $scenario . ': no partial writes');
        $connection->transaction(static function () use ($connection): void {
            $connection->table('records')->insert(['value'=>'fresh-transaction']);
        });
        if ($scenario !== 'full-with-trigger') {
            check($connection->getPdo() !== $oldPdo, $scenario . ': replace uncertain connection');
        }
        check((int)$observer->query('SELECT count(*) FROM records')->fetchColumn() === 1, $scenario . ': fresh commit visible independently');
        $connection->disconnect();
        check((int)$observer->query('SELECT count(*) FROM records')->fetchColumn() === 1, $scenario . ': fresh commit survives disconnect');
    } finally {
        unset($connection, $observer, $oldPdo, $fail);
        foreach ([$file, $file.'-wal', $file.'-shm'] as $path) { if (is_file($path)) { unlink($path); } }
    }
}
foreach (['outer', 'nested', 'nested-caught', 'nested-swallowed', 'query-caught', 'manual-rollback', 'manual-commit', 'conflict-rollback', 'trigger-rollback', 'full-with-trigger'] as $scenario) {
    verifyAutomaticRollback($scenario);
}
$db = tempnam(sys_get_temp_dir(), 'commerce-tx-');
try {
    $native = new PDO('sqlite:' . $db);
    $native->exec('PRAGMA journal_mode=WAL');
    $native->exec('CREATE TABLE stock(id INTEGER PRIMARY KEY, remaining INTEGER CHECK(remaining>=0)); INSERT INTO stock VALUES(1,1)');
    $native->exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
    $native->exec('BEGIN IMMEDIATE');
    check(!$native->inTransaction(), 'native PDO limitation changed');
    $native->exec('ROLLBACK');
    $c = Bootstrap::boot(['driver'=>'sqlite', 'database'=>$db])->getConnection();
    $p = $c->getPdo();
    check($p instanceof ImmediatePDO, 'registered adapter');
    check((int)$p->query('PRAGMA synchronous')->fetchColumn() === 2, 'durability');
    $c->transaction(function () use ($c, $p, $db) {
        check($p->inTransaction(), 'outer state');
        $c->table('stock')->where('id',1)->update(['remaining'=>3]);
        try {
            $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>2]); throw new RuntimeException('rollback inner'); });
        } catch (RuntimeException $e) { check($e->getMessage()==='rollback inner', 'inner exception'); }
        check((int)$c->table('stock')->value('remaining')===3, 'savepoint rollback');
        try {
            $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>-1]); });
            check(false, 'constraint must fail');
        } catch (PDOException $error) { check((int)$error->errorInfo[1] === 19, 'ordinary constraint error'); }
        check($c->transactionLevel() === 1 && (int)$c->table('stock')->value('remaining') === 3, 'constraint rollback preserves healthy outer transaction');
        $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>1]); });
        $start=microtime(true);
        $process=proc_open([PHP_BINARY,__FILE__,'contend',$db],[1=>['pipe','w'],2=>['pipe','w']],$pipes);
        $out=stream_get_contents($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);
        check(proc_close($process)===0, 'contender failed: '.$out.$err);
        check(microtime(true)-$start<2, 'bounded timeout');
        check((int)$c->table('stock')->where('remaining',1)->update(['remaining'=>0])===1, 'final card winner');
    });
    check(!$p->inTransaction() && $c->transactionLevel()===0, 'committed state');
    check((int)$native->query('SELECT remaining FROM stock')->fetchColumn()===0, 'committed visible');
    try { $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>1]);throw new RuntimeException('rollback outer'); }); }
    catch (RuntimeException $e) { check($e->getMessage()==='rollback outer','outer error'); }
    check((int)$c->table('stock')->value('remaining')===0, 'outer rollback');
    // Commit-time deferred FK failure must not leak the transaction/locks.
    try { $c->transaction(function () use ($c) { $c->table('child')->insert(['pid'=>999]); });throw new RuntimeException('commit should fail'); }
    catch (PDOException $e) { check(str_contains($e->getMessage(),'FOREIGN KEY'), 'commit failure'); }
    check(!$p->inTransaction() && $c->transactionLevel()===0, 'failed commit cleanup');
    check($c->table('child')->count()===0, 'failed commit rollback');
    check($c->getPdo() !== $p, 'discard connection after failed commit');
    $beforeManualCommit = $c->getPdo();
    $c->beginTransaction();
    $c->table('child')->insert(['pid'=>999]);
    try { $c->commit(); check(false, 'manual deferred commit must fail'); }
    catch (PDOException $error) { check(str_contains($error->getMessage(), 'FOREIGN KEY'), 'manual original commit error'); }
    check($c->transactionLevel() === 0 && !$beforeManualCommit->inTransaction(), 'manual commit failure resets transaction');
    check($c->table('child')->count() === 0, 'manual commit failure has no partial write');
    check($c->getPdo() !== $beforeManualCommit, 'manual commit failure replaces connection');
    $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>1]); });
    check((int)$c->table('stock')->value('remaining')===1, 'reuse after commit failure');
    check($c->selectOne("SELECT json_extract(?, '$.color') AS v",['{"color":"蓝色"}'])->v==='蓝色','JSON SKU');
    check(PaymentAmount::matches('0.30','0.3000'),'equivalent payment');
    foreach ([NAN, INF, -1, '1e2', '0.301', [], null, '0.30x'] as $value) { check(!PaymentAmount::matches('0.30',$value),'reject invalid payment'); }
    echo "PASS transaction/savepoint/automatic-rollback/recovery/commit-failure/contention/JSON/payment\n";
} finally {
    unset($native,$p,$c,$capsule);
    foreach ([$db,$db.'-wal',$db.'-shm'] as $path) { if (is_file($path)) unlink($path); }
}
