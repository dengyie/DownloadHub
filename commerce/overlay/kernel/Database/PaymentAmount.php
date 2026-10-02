<?php
declare(strict_types=1);

namespace Kernel\Database;

/** Validate provider amounts before comparing fixed-scale payment values. */
final class PaymentAmount
{
    public static function normalize(mixed $amount): string
    {
        if (!is_string($amount) && !is_int($amount) && !is_float($amount)) {
            throw new \InvalidArgumentException('Invalid payment amount');
        }
        $text = (string)$amount;
        if (!preg_match('/\A\d{1,8}(?:\.\d{1,2}0*)?\z/D', $text)) {
            throw new \InvalidArgumentException('Invalid payment amount');
        }
        return bcadd($text, '0', 2);
    }

    public static function matches(mixed $expected, mixed $received): bool
    {
        try {
            return bccomp(self::normalize($expected), self::normalize($received), 2) === 0;
        } catch (\InvalidArgumentException $error) {
            return false;
        }
    }
}
