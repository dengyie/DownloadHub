<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

use App\Controller\Admin\Api\Card as AdminCard;
use App\Controller\User\Api\Card as MerchantCard;
use App\Model\Card;
use App\Model\Order;
use App\Util\Context;
use Illuminate\Database\Capsule\Manager as DB;
use Kernel\Database\Bootstrap;
use Kernel\Exception\JSONException;

function lang(string $message): string { return $message; }
function verify(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
function fixture(string $table, array $values): int {
    $defaults = [];
    foreach (DB::select('PRAGMA table_info("acg_' . $table . '")') as $column) {
        if ($column->notnull && $column->dflt_value === null && !$column->pk) {
            $defaults[$column->name] = in_array($column->type, ['INTEGER', 'NUMERIC', 'REAL'], true) ? 0 : 'fixture';
        }
    }
    return (int)DB::table($table)->insertGetId(array_replace($defaults, $values));
}
function rejectDeletion(callable $operation, string $message): void {
    try { $operation(); }
    catch (JSONException $expected) { return; }
    throw new RuntimeException($message);
}
function makeOrder(int $commodity, int $pay, int $card, string $trade, int $paid, int $delivered): int {
    return fixture('order', ['commodity_id'=>$commodity, 'pay_id'=>$pay, 'card_id'=>$card,
        'trade_no'=>$trade, 'card_num'=>1, 'status'=>$paid, 'delivery_status'=>$delivered,
        'secret'=>$delivered ? 'already-delivered-secret' : '']);
}

$file = tempnam(sys_get_temp_dir(), 'commerce-delete-');
try {
    $schema = getenv('COMMERCE_SCHEMA_DB') ?: throw new RuntimeException('Schema fixture required');
    verify(realpath($schema) === realpath(dirname(rtrim(BASE_PATH, '/')) . '/schema.sqlite'), 'schema must belong to this fixture');
    $source = new PDO('sqlite:file:' . $schema . '?mode=ro');
    $target = new PDO('sqlite:' . $file);
    $target->exec('PRAGMA journal_mode=WAL');
    foreach ($source->query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END") as $object) {
        $target->exec($object['sql']);
    }
    $source = $target = null;
    Bootstrap::boot(['driver'=>'sqlite', 'database'=>$file, 'prefix'=>'acg_']);
    Kernel\Database\CommerceSchema::upgrade();
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_SERVER['HTTP_USER_AGENT'] = 'isolated-card-deletion-test';
    $manager = new App\Model\Manage();
    $manager->email = 'manager@example.invalid';
    $manager->nickname = 'fixture';
    $manager->last_login_ip = '127.0.0.1';
    Context::set(App\Consts\Manage::SESSION, $manager);
    $merchantId = fixture('user', ['username'=>'merchant', 'email'=>'merchant@example.invalid']);
    $foreignId = fixture('user', ['username'=>'other', 'email'=>'other@example.invalid']);
    Context::set(App\Consts\User::SESSION, App\Model\User::find($merchantId));
    $pay = fixture('pay', ['name'=>'fixture', 'handle'=>'Fixture']);
    $commodity = fixture('commodity', ['name'=>'fixture', 'code'=>'fixture', 'delivery_way'=>0, 'send_email'=>0]);
    $merchantCommodity = fixture('commodity', ['name'=>'merchant', 'code'=>'merchant', 'owner'=>$merchantId, 'delivery_way'=>0, 'send_email'=>0]);

    if (($argv[1] ?? '') !== '--merchant-only') {
        $pendingCard = fixture('card', ['commodity_id'=>$commodity, 'secret'=>'selected-pending', 'status'=>2]);
        $pending = makeOrder($commodity, $pay, $pendingCard, 'paid-pending', 1, 0);
        $admin = new AdminCard();
        $_POST = ['list'=>[$pendingCard]];
        $impact = $admin->deleteImpact()['data'];
        verify($impact['blocked_count'] === 1 && !$impact['can_delete'], 'paid pending selected card was reported deletable');
        rejectDeletion(fn () => $admin->del(), 'admin removed paid pending selected card');
        verify(Card::find($pendingCard) !== null && Order::find($pending)->card_id === $pendingCard, 'admin changed pending selected reference');
        $alternative = fixture('card', ['commodity_id'=>$commodity, 'secret'=>'explicit-replacement', 'status'=>0]);
        $service = new App\Service\Bind\Order();
        verify(!$service->retryDelivery($pending), 'blocked deletion allowed arbitrary replacement');
        verify(Card::find($alternative)->status === 0, 'pending selected order consumed an unselected card');
        $unpaidCard = fixture('card', ['commodity_id'=>$commodity, 'secret'=>'unpaid-selection', 'status'=>0]);
        $unpaid = makeOrder($commodity, $pay, $unpaidCard, 'unpaid', 0, 0);
        $deliveredCard = fixture('card', ['commodity_id'=>$commodity, 'secret'=>'delivered', 'status'=>1]);
        $delivered = makeOrder($commodity, $pay, $deliveredCard, 'delivered', 1, 1);
        $freeCard = fixture('card', ['commodity_id'=>$commodity, 'secret'=>'unreferenced', 'status'=>0]);
        $_POST = ['list'=>[$pendingCard, $unpaidCard, $deliveredCard, $freeCard]];
        $result = $admin->del()['data'];
        verify($result['deleted_count'] === 2 && $result['skipped_count'] === 2, 'mixed admin delete did not skip all pending references');
        verify(Card::find($pendingCard) !== null && Card::find($unpaidCard) !== null, 'mixed admin delete removed reserved stock');
        verify(Order::find($unpaid)->card_id === $unpaidCard && Order::find($pending)->card_id === $pendingCard, 'mixed admin delete detached pending references');
        verify(Order::find($delivered)->card_id === null && Order::find($delivered)->secret === 'already-delivered-secret', 'delivered history was not preserved');
        verify($service->retryDelivery($pending, $alternative), 'explicit selected replacement no longer works');
        verify(Order::find($pending)->card_id === $alternative && Order::find($pending)->secret === 'explicit-replacement', 'explicit replacement was not assigned');
    }

    $merchantPendingCard = fixture('card', ['commodity_id'=>$merchantCommodity, 'owner'=>$merchantId, 'secret'=>'merchant-selected', 'status'=>2]);
    $merchantPending = makeOrder($merchantCommodity, $pay, $merchantPendingCard, 'merchant-pending', 1, 0);
    $merchantFree = fixture('card', ['commodity_id'=>$merchantCommodity, 'owner'=>$merchantId, 'secret'=>'merchant-free', 'status'=>0]);
    $foreignCard = fixture('card', ['commodity_id'=>$merchantCommodity, 'owner'=>$foreignId, 'secret'=>'foreign-owner', 'status'=>0]);
    $merchant = new MerchantCard();
    $_POST = ['list'=>[$merchantPendingCard, $merchantFree, $foreignCard]];
    rejectDeletion(fn () => $merchant->del(), 'merchant removed paid pending selected card');
    verify(Card::find($merchantPendingCard) !== null && Card::find($merchantFree) !== null, 'rejected merchant deletion was not atomic');
    verify(Card::find($foreignCard) !== null && Order::find($merchantPending)->card_id === $merchantPendingCard, 'merchant changed other owner or pending reference');
    $merchantDeliveredCard = fixture('card', ['commodity_id'=>$merchantCommodity, 'owner'=>$merchantId, 'secret'=>'merchant-delivered', 'status'=>1]);
    $merchantDelivered = makeOrder($merchantCommodity, $pay, $merchantDeliveredCard, 'merchant-delivered', 1, 1);
    $_POST = ['list'=>[$merchantFree, $merchantDeliveredCard, $foreignCard]];
    $merchant->del();
    verify(Card::find($merchantFree) === null && Card::find($merchantDeliveredCard) === null, 'merchant could not delete unreserved owned cards');
    verify(Card::find($foreignCard) !== null, 'merchant deleted another owner card');
    verify(Order::find($merchantDelivered)->card_id === null && Order::find($merchantDelivered)->secret === 'already-delivered-secret', 'merchant deletion damaged delivered history');
    verify(Order::find($merchantPending)->card_id === $merchantPendingCard, 'merchant deletion detached a pending selection');
    verify(DB::selectOne('PRAGMA integrity_check')->integrity_check === 'ok', 'database integrity');
    echo "PASS: admin/merchant pending selected-card deletion guards, preview, mixed batches, delivered history, explicit replacement, owner authorization\n";
} finally {
    DB::connection()->disconnect();
    foreach ([$file, $file.'-wal', $file.'-shm'] as $path) if (is_file($path)) unlink($path);
}
