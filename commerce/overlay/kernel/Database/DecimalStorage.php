<?php
declare(strict_types=1);

namespace Kernel\Database;

/** SQLite REAL round() differs from MySQL DECIMAL at half-cent boundaries. */
final class DecimalStorage
{
    public static function register(\PDO $pdo): void
    {
        $pdo->sqliteCreateFunction('decimal_round', [self::class, 'round'], 2, \PDO::SQLITE_DETERMINISTIC);
    }

    public static function round(mixed $value, int $scale): ?string
    {
        if ($value === null) {
            return null;
        }
        if ($scale < 0 || $scale > 8 || (!is_string($value) && !is_int($value) && !is_float($value))) {
            throw new \InvalidArgumentException('Invalid decimal');
        }
        $text = (string)$value;
        if (!preg_match('/\A([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?\z/D', $text, $parts)) {
            throw new \InvalidArgumentException('Invalid decimal');
        }
        $exponent = (int)($parts[4] ?? 0);
        if (abs($exponent) > 30 || strlen($text) > 128) {
            throw new \InvalidArgumentException('Decimal out of range');
        }
        $digits = $parts[2] . ($parts[3] ?? '');
        $point = strlen($parts[2]) + $exponent;
        if ($point <= 0) {
            $unsigned = '0.' . str_repeat('0', -$point) . $digits;
        } elseif ($point >= strlen($digits)) {
            $unsigned = $digits . str_repeat('0', $point - strlen($digits));
        } else {
            $unsigned = substr($digits, 0, $point) . '.' . substr($digits, $point);
        }
        $half = $scale === 0 ? '0.5' : '0.' . str_repeat('0', $scale) . '5';
        $rounded = bcadd($unsigned, $half, $scale);
        return ($parts[1] === '-' && bccomp($rounded, '0', $scale) !== 0 ? '-' : '') . $rounded;
    }
}
