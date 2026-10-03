<?php
declare(strict_types=1);

namespace App\Service\Bind;

use App\Model\Commodity;
use App\Model\Order;
use App\Service\Email;
use Illuminate\Database\Capsule\Manager as DB;

/** One durable delivery notice per order; SMTP is deliberately outside transactions. */
final class OrderNotification
{
    public static function enqueue(Order $order, Commodity $commodity): void
    {
        if (DB::connection()->transactionLevel() < 1) {
            throw new \LogicException('Notification must be recorded with its order');
        }
        if ((int)$order->status !== 1 || (int)$order->delivery_status !== 1
            || (int)$commodity->contact_type !== 2 || (int)$commodity->send_email !== 1
            || (int)$order->owner !== 0) {
            return;
        }
        if (!DB::table('order_notification')->where('order_id', $order->id)->exists()) {
            DB::table('order_notification')->insert(['order_id' => $order->id]);
        }
    }

    /** @return array{sent:int,failed:int} */
    public static function dispatch(Email $email, int $limit = 20): array
    {
        if ($limit < 1 || $limit > 100 || DB::connection()->transactionLevel() !== 0) {
            throw new \LogicException('Notification dispatch requires no enclosing transaction and a bounded batch');
        }
        $result = ['sent' => 0, 'failed' => 0];
        for ($i = 0; $i < $limit; ++$i) {
            $claim = DB::transaction(static function (): ?array {
                $now = time();
                $task = DB::table('order_notification')->whereNull('sent_at')
                    ->where('available_at', '<=', $now)->where('lease_until', '<=', $now)
                    ->orderBy('available_at')->orderBy('order_id')->lockForUpdate()->first();
                if (!$task) return null;
                $token = bin2hex(random_bytes(16));
                DB::table('order_notification')->where('order_id', $task->order_id)->update([
                    'lease_token' => $token, 'lease_until' => $now + 300, 'attempts' => $task->attempts + 1,
                ]);
                return [$task, $token, Order::findOrFail($task->order_id)];
            });
            if ($claim === null) break;
            [$task, $token, $order] = $claim;
            $sent = false;
            try {
                if ((int)$order->status === 1 && (int)$order->delivery_status === 1) {
                    $sent = $email->send((string)$order->contact, '【发货提醒】您购买的卡密发货啦', '您购买的卡密如下：' . $order->secret);
                }
            } catch (\Throwable $failure) {
                // The durable task records failure, without logging SMTP credentials or card secrets.
            }
            $now = time();
            DB::table('order_notification')->where('order_id', $task->order_id)->where('lease_token', $token)->update([
                'sent_at' => $sent ? $now : null,
                'available_at' => $sent ? $now : $now + min(3600, 60 * (2 ** min((int)$task->attempts, 6))),
                'lease_token' => null, 'lease_until' => 0,
            ]);
            ++$result[$sent ? 'sent' : 'failed'];
        }
        return $result;
    }
}
