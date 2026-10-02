<?php
declare(strict_types=1);
require getenv('COMMERCE_VENDOR') ?: '/var/www/html/vendor/autoload.php';
spl_autoload_register(static function ($class) {
    if (str_starts_with($class, 'Kernel\\Database\\')) {
        require __DIR__ . '/../overlay/kernel/Database/' . substr($class, 16) . '.php';
    }
}, true, true);
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
    $c->transaction(function () use ($c) { $c->table('stock')->update(['remaining'=>1]); });
    check((int)$c->table('stock')->value('remaining')===1, 'reuse after commit failure');
    check($c->selectOne("SELECT json_extract(?, '$.color') AS v",['{"color":"蓝色"}'])->v==='蓝色','JSON SKU');
    check(PaymentAmount::matches('0.30','0.3000'),'equivalent payment');
    foreach ([NAN, INF, -1, '1e2', '0.301', [], null, '0.30x'] as $value) { check(!PaymentAmount::matches('0.30',$value),'reject invalid payment'); }
    echo "PASS transaction/savepoint/rollback/commit-failure/contention/JSON/payment\n";
} finally {
    unset($native,$p,$c,$capsule);
    foreach ([$db,$db.'-wal',$db.'-shm'] as $path) { if (is_file($path)) unlink($path); }
}
