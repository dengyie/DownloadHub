<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/kernel/Console.php';
error_reporting(E_ALL & ~E_DEPRECATED);

use App\Model\Order;
use App\Service\Bind\Order as OrderService;
use App\Service\Bind\OrderNotification;
use Illuminate\Database\Capsule\Manager as DB;

$options = getopt('', ['once', 'migrate', 'retry-order:', 'replacement-card:']);
if (count($options) === 0 || (isset($options['replacement-card']) && !isset($options['retry-order']))) {
    fwrite(STDERR, "Usage: --once | --migrate | --retry-order=ID [--replacement-card=ID]\n");
    exit(2);
}
try {
    if (isset($options['migrate'])) {
        Kernel\Database\CommerceSchema::upgrade();
        echo "Commerce schema ready\n";
        exit;
    }
    $service = new OrderService(); // Local stock retry has no remote fulfillment dependency.
    if (isset($options['retry-order'])) {
        $id = filter_var($options['retry-order'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $card = isset($options['replacement-card'])
            ? filter_var($options['replacement-card'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) : null;
        if ($id === false || $card === false) throw new InvalidArgumentException('Invalid order/card ID');
        $delivered = $service->retryDelivery($id, $card);
        echo $delivered ? "Order delivered\n" : "Order still awaiting matching inventory\n";
        exit($delivered ? 0 : 3);
    }
    $delivered = 0;
    $pending = Order::query()->where('status', 1)->where('delivery_status', 0)
        ->where('fulfillment_retry_at', '<=', time())
        ->whereHas('commodity', static function ($query): void {
            $query->where('delivery_way', 0)->where(static function ($query): void {
                $query->whereNull('shared_id')->orWhere('shared_id', 0);
            });
        })->orderBy('fulfillment_retry_at')->orderBy('id')->limit(20)->pluck('id');
    foreach ($pending as $id) {
        try {
            $delivered += $service->retryDelivery((int)$id) ? 1 : 0;
        } catch (Kernel\Exception\JSONException $expected) {
            // Order/commodity may change between selection and its transaction.
            DB::table('order')->where('id', $id)->update(['fulfillment_retry_at' => time() + 300]);
            fwrite(STDERR, "Fulfillment deferred: order_id=" . (int)$id . "\n");
        }
    }
    $mail = OrderNotification::dispatch(new App\Service\Bind\Email());
    echo json_encode(['delivered' => $delivered, 'notifications' => $mail], JSON_THROW_ON_ERROR) . "\n";
    exit($mail['failed'] > 0 ? 1 : 0);
} catch (Throwable $failure) {
    // Database exceptions may contain bindings, recipient addresses or card data.
    fwrite(STDERR, 'Commerce maintenance failed: ' . get_class($failure) . "\n");
    exit(1);
} finally {
    DB::connection()->disconnect();
}
