<?php
declare(strict_types=1);

namespace App\Model;


use App\Util\Date;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Capsule\Manager as DB;
use Kernel\Exception\JSONException;

/**
 * @property float $amount
 * @property float $balance
 * @property string $create_time
 * @property int $id
 * @property string $log
 * @property int $owner
 * @property int $type
 * @property int $currency
 */
class Bill extends Model
{
    const TYPE_ADD = 1;
    const TYPE_SUB = 0;

    /**
     * @var string
     */
    protected $table = "bill";

    /**
     * @var bool
     */
    public $timestamps = false;

    /**
     * @var array
     */
    protected $casts = ['amount' => 'float', 'balance' => 'float', 'id' => 'integer', 'owner' => 'integer', 'type' => 'integer', 'currency' => 'integer'];


    public function owner(): ?HasOne
    {
        return $this->hasOne(User::class, "id", "owner");
    }

    /**
     * @param User|int|string $user
     * @param float $amount
     * @param int $type
     * @param string $log
     * @param int $currency
     * @param bool $total
     * @throws JSONException
     */
    public static function create(User|int|string $user, float $amount, int $type, string $log, int $currency = 0, bool $total = true): void
    {
        if (!is_finite($amount) || $amount <= 0 || $amount > 99999999.99
            || abs($amount - round($amount, 2)) > max(1e-9, abs($amount) * PHP_FLOAT_EPSILON * 4)
            || !in_array($type, [self::TYPE_ADD, self::TYPE_SUB], true)
            || !in_array($currency, [0, 1], true)) {
            throw new JSONException("非法金额或账本操作");
        }
        $decimalAmount = number_format($amount, 2, '.', '');
        if (bccomp($decimalAmount, '0', 2) <= 0) {
            throw new JSONException("非法金额");
        }
        $userId = $user instanceof User ? $user->id : $user;

        // Re-read inside the transaction: callers may pass an authentication
        // snapshot or a model used by an earlier debit in this transaction.
        $updated = DB::transaction(static function () use ($userId, $decimalAmount, $type, $log, $currency, $total): User {
            $current = User::query()->lockForUpdate()->find($userId);
            if (!$current) {
                throw new JSONException("用户不存在");
            }
            $balanceField = $currency === 0 ? 'balance' : 'coin';
            $totalField = $currency === 0 ? 'recharge' : 'total_coin';
            $balance = number_format((float)$current->getRawOriginal($balanceField), 2, '.', '');
            $next = $type === self::TYPE_SUB
                ? bcsub($balance, $decimalAmount, 2)
                : bcadd($balance, $decimalAmount, 2);
            if (bccomp($next, '0', 2) < 0) {
                throw new JSONException($currency === 0 ? "余额不足" : "硬币不足");
            }
            if (bccomp($next, '999999999999.99', 2) > 0) {
                throw new JSONException("余额超出范围");
            }
            $current->{$balanceField} = $next;
            if ($type === self::TYPE_ADD && $total) {
                $previousTotal = number_format((float)$current->getRawOriginal($totalField), 2, '.', '');
                $nextTotal = bcadd($previousTotal, $decimalAmount, 2);
                if (bccomp($nextTotal, '999999999999.99', 2) > 0) {
                    throw new JSONException("累计金额超出范围");
                }
                $current->{$totalField} = $nextTotal;
            }
            $current->save();

            $bill = new self();
            $bill->owner = $current->id;
            $bill->amount = $decimalAmount;
            $bill->currency = $currency;
            $bill->balance = $next;
            $bill->type = $type;
            $bill->log = $log;
            $bill->create_time = Date::current();
            $bill->save();
            return $current;
        });
        if ($user instanceof User) {
            // Callers return this model or save other fields afterwards. Reflect
            // committed financial values without overwriting unrelated changes.
            $fields = ['balance', 'coin', 'recharge', 'total_coin'];
            foreach ($fields as $field) {
                $user->setAttribute($field, $updated->getRawOriginal($field));
            }
            $user->syncOriginalAttributes($fields);
        }
    }
}
