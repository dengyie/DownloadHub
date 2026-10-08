<?php
declare(strict_types=1);

namespace App\Util;

/**
 * Public bootstrap data only; no model, configuration, session, or HTTP dependencies.
 * Field mappings follow lizhipay/acg-faka at a4cf9eb4dd9a41ca663689fde0f52bfa7478e716.
 */
final class StorefrontPayload
{
    public static function build(
        array $config,
        ?array $business = null,
        ?array $user = null,
        array $query = []
    ): array {
        $branding = $business ?? $config;
        $supportUrl = self::safeUrl($branding['service_url'] ?? null);
        $from = self::integer($query['from'] ?? null);

        if ($business !== null) {
            // An empty business support URL uses its QQ contact, as in the existing view.
            if (($business['service_url'] ?? '') === '') {
                $qq = $business['service_qq'] ?? null;
                if ((is_string($qq) || is_int($qq))
                    && preg_match('/\A[0-9]{1,16}\z/', (string)$qq) === 1
                    && trim((string)$qq, '0') !== '') {
                    $supportUrl = 'https://wpa.qq.com/msgrd?v=1&uin=' . $qq;
                }
            }
            if ($from === 0) {
                $from = self::integer($business['user_id'] ?? null);
            }
        }

        $member = null;
        $userId = self::integer($user['id'] ?? null);
        if ($user !== null && $userId > 0) {
            $member = [
                'id' => $userId,
                'username' => self::text($user['username'] ?? null),
                'avatar' => self::safeUrl($user['avatar'] ?? null),
                // Upstream User::$casts exposes balance as a float; this performs no money math.
                'balance' => self::balance($user['balance'] ?? null),
                'group_name' => self::text($user['group_name'] ?? null),
            ];
        }

        return [
            'name' => self::text($branding['shop_name'] ?? null),
            'title' => self::text($branding['title'] ?? null),
            'notice' => self::text($branding['notice'] ?? null),
            'support_url' => $supportUrl,
            'closed' => self::enabled($config['closed'] ?? null),
            'default_category' => self::integer($config['default_category'] ?? null),
            'from' => $from,
            'auth' => [
                'registration_enabled' => self::enabled($config['registered_state'] ?? null),
                // Registration: 0 = username, 1 = phone, 2 = email.
                'registration_type' => self::integer($config['registered_type'] ?? null, 0, 0, 2),
                'registration_captcha' => self::enabled($config['registered_verification'] ?? null),
                'email_verification' => self::enabled($config['registered_email_verification'] ?? null),
                'phone_verification' => self::enabled($config['registered_phone_verification'] ?? null),
                'login_captcha' => self::enabled($config['login_verification'] ?? null),
                // Upstream settings accept 1..32 and default to 6.
                'username_min_length' => self::integer($config['username_len'] ?? null, 6, 1, 32),
                // Recovery: 0 = email, 1 = phone (different from registration).
                'recovery_type' => self::integer($config['forget_type'] ?? null, 0, 0, 1),
            ],
            'user' => $member,
        ];
    }

    private static function text(mixed $value): string
    {
        return is_string($value) && preg_match('//u', $value) === 1 ? $value : '';
    }

    private static function enabled(mixed $value): bool
    {
        return $value === '1' || $value === 1 || $value === true;
    }

    private static function integer(
        mixed $value,
        int $default = 0,
        int $minimum = 0,
        int $maximum = PHP_INT_MAX
    ): int {
        if (is_string($value) && preg_match('/\A[0-9]+\z/', $value) === 1) {
            $value = ltrim($value, '0');
            $value = $value === '' ? '0' : $value;
        } elseif (!is_int($value)) {
            return $default;
        }

        $number = filter_var($value, FILTER_VALIDATE_INT, [
            'options' => ['min_range' => $minimum, 'max_range' => $maximum],
        ]);
        return $number === false ? $default : $number;
    }

    private static function balance(mixed $value): float
    {
        if (!is_int($value) && !is_float($value) && !(is_string($value) && is_numeric($value))) {
            return 0.0;
        }
        $number = (float)$value;
        return is_finite($number) && $number >= 0 ? $number : 0.0;
    }

    private static function safeUrl(mixed $value): string
    {
        if (!is_string($value) || $value === '' || str_contains($value, '\\')
            || preg_match('/[\p{C}\p{Z}]/u', $value) !== 0) {
            return '';
        }

        // Also reject encoded controls/backslashes and encoded network-path references.
        $decoded = rawurldecode($value);
        if (str_contains($decoded, '\\') || preg_match('/\p{C}/u', $decoded) !== 0) {
            return '';
        }
        if (str_starts_with($value, '/')) {
            return str_starts_with($decoded, '//') ? '' : $value;
        }

        $parts = parse_url($value);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])
            || !in_array(strtolower($parts['scheme']), ['http', 'https'], true)
            || isset($parts['user']) || isset($parts['pass'])
            || filter_var($value, FILTER_VALIDATE_URL) === false) {
            return '';
        }
        return $value;
    }
}
