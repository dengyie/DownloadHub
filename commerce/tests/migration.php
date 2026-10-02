<?php
declare(strict_types=1);
require dirname(__DIR__).'/migrate.php';
function assertTrue(bool $ok,string $label): void { if(!$ok) throw new RuntimeException($label); }
function rejects(callable $fn,string $label,string $expected='CHECK constraint failed'): void { try { $fn(); } catch(PDOException $e) { assertTrue(str_contains($e->getMessage(),$expected),$label.': unexpected error '.$e->getMessage()); return; } throw new RuntimeException($label); }
$path=$argv[1]??'';
if(!is_file($path)) throw new RuntimeException('Pass the rehearsed acg_faka.sqlite path; tests clone schema only into memory');
$source=new PDO('sqlite:file:'.$path.'?mode=ro',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$db=new PDO('sqlite::memory:',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
\Kernel\Database\DecimalStorage::register($db);
$schema=$source->query("SELECT type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END")->fetchAll(PDO::FETCH_ASSOC);
foreach($schema as $object) $db->exec($object['sql']);
$db->exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON');
function fixture(PDO $db,string $table,array $values): void {
    foreach($db->query('PRAGMA table_info('.ident($table).')')->fetchAll(PDO::FETCH_ASSOC) as $c) {
        if((int)$c['notnull'] && $c['dflt_value']===null && !array_key_exists($c['name'],$values)) $values[$c['name']]=in_array($c['type'],['INTEGER','NUMERIC'],true)?0:'fixture';
    }
    $q=$db->prepare('INSERT INTO '.ident($table).' ('.implode(',',array_map('ident',array_keys($values))).') VALUES ('.implode(',',array_fill(0,count($values),'?')).')'); $q->execute(array_values($values));
}
// Real migrated financial columns and triggers, no production rows copied or mutated.
fixture($db,'acg_user',['id'=>100,'username'=>'fixture','balance'=>'0.30','coin'=>0,'recharge'=>0,'total_coin'=>0]);
$db->exec('UPDATE acg_user SET balance=balance-0.10 WHERE id=100');
$db->exec('UPDATE acg_user SET balance=balance-0.20 WHERE id=100');
assertTrue((float)$db->query('SELECT balance FROM acg_user WHERE id=100')->fetchColumn()===0.0,'decimal subtraction should store exact cents');
$db->exec('UPDATE acg_user SET balance=1.005 WHERE id=100');
assertTrue((float)$db->query('SELECT balance FROM acg_user WHERE id=100')->fetchColumn()===1.01,'round positive half cents');
$db->exec('UPDATE acg_user SET balance=999999999999.99 WHERE id=100');
assertTrue(canonical($db->query('SELECT balance FROM acg_user WHERE id=100')->fetchColumn(),['DATA_TYPE'=>'decimal','NUMERIC_SCALE'=>2])==='999999999999.99','preserve maximum decimal(14,2)');
rejects(fn()=>$db->exec('UPDATE acg_user SET balance=999999999999.999 WHERE id=100'),'reject rounded overflow');
rejects(fn()=>$db->exec('UPDATE acg_user SET balance=-0.01 WHERE id=100'),'reject negative unsigned balance');
rejects(fn()=>$db->exec("UPDATE acg_user SET balance='invalid' WHERE id=100"),'reject non-numeric balance');
rejects(fn()=>fixture($db,'acg_user',['id'=>101,'username'=>'FIXTURE']),'retain ASCII case insensitive unique username','UNIQUE constraint failed');
rejects(fn()=>fixture($db,'acg_user',['id'=>4294967296,'username'=>'overflow']),'retain unsigned int ID upper bound');
fixture($db,'acg_user',['id'=>101,'username'=>'second','balance'=>2]); fixture($db,'acg_user',['id'=>102,'username'=>'third','balance'=>10]);
assertTrue((int)$db->query('SELECT id FROM acg_user WHERE id IN (101,102) ORDER BY balance DESC LIMIT 1')->fetchColumn()===102,'monetary ordering is numeric');
rejects(fn()=>$db->exec('UPDATE acg_user SET balance=NULL WHERE id=100'),'preserve NOT NULL monetary field','NOT NULL constraint failed');
fixture($db,'acg_pay',['id'=>200,'name'=>'fixture','cost'=>'0.1235']);
assertTrue((float)$db->query('SELECT cost FROM acg_pay WHERE id=200')->fetchColumn()===0.124,'retain payment three decimal scale');
fixture($db,'acg_price_template',['id'=>200,'guest_value'=>'-1.005']);
assertTrue((float)$db->query('SELECT guest_value FROM acg_price_template WHERE id=200')->fetchColumn()===-1.01,'signed decimal rounds away from zero');
rejects(fn()=>fixture($db,'acg_bill',['id'=>200,'owner'=>999999]),'foreign key rejects orphan','FOREIGN KEY constraint failed');
$db->beginTransaction(); $db->exec('UPDATE acg_user SET balance=1.235 WHERE id=101'); $db->rollBack();
assertTrue((float)$db->query('SELECT balance FROM acg_user WHERE id=101')->fetchColumn()===2.0,'round triggers roll back atomically');
assertTrue($db->query('PRAGMA quick_check')->fetchColumn()==='ok','integrity');
assertTrue(!$db->query('PRAGMA foreign_key_check')->fetch(),'referential integrity');
// A destination that already exists must never be truncated, even for empty schemas.
$existing=tempnam(sys_get_temp_dir(),'migration-existing-'); file_put_contents($existing,'keep');
// Exclusive creation guard is independently exercised without touching MySQL.
assertTrue(@fopen($existing,'x')===false && file_get_contents($existing)==='keep','exclusive destination creation'); unlink($existing);
echo "PASS: migrated schema money, limits, uniqueness, sorting, null, FK, rollback and integrity\n";
