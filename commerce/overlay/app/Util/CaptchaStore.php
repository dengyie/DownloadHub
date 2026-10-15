<?php
declare(strict_types=1);

namespace App\Util;

use PDO;

/** Independent, short-lived challenges shared by PHP workers; never a shop DB. */
final class CaptchaStore
{
    public const TTL = 300;
    public const SCENES = [
        'login', 'register', 'adminLogin', 'trade',
        'emailRegisterCaptcha', 'emailForgetCaptcha',
        'phoneRegisterCaptcha', 'phoneForgetCaptcha', 'emailBindNew', 'phoneBindNew',
    ];
    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    public function __construct(private PDO $db)
    {
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('PRAGMA busy_timeout = 2500');
        $db->exec('CREATE TABLE IF NOT EXISTS challenges (
            id TEXT PRIMARY KEY, scene TEXT NOT NULL, ip_hash TEXT NOT NULL,
            answer_hash TEXT, expires_at INTEGER NOT NULL
        )');
        $db->exec('CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at)');
        $db->exec('CREATE INDEX IF NOT EXISTS challenges_ip ON challenges(ip_hash)');
    }

    public static function open(): self
    {
        $temporary = realpath(sys_get_temp_dir());
        if ($temporary === false) throw new \RuntimeException('Captcha temporary directory unavailable');
        $directory = $temporary . '/opencardgate-captcha-' . substr(hash('sha256', realpath(BASE_PATH) ?: BASE_PATH), 0, 20);
        if (!is_dir($directory) && !@mkdir($directory, 0700) && !is_dir($directory)) {
            throw new \RuntimeException('Cannot create captcha directory');
        }
        $info = lstat($directory);
        if (!$info || is_link($directory) || ($info['mode'] & 0077) !== 0 || !is_writable($directory)
            || (function_exists('posix_geteuid') && $info['uid'] !== posix_geteuid())) {
            throw new \RuntimeException('Unsafe captcha directory');
        }
        $path = $directory . '/challenges.sqlite';
        if (!file_exists($path)) {
            $mask = umask(0077);
            try {
                $file = @fopen($path, 'x');
                if (is_resource($file)) fclose($file);
            } finally {
                umask($mask);
            }
        }
        $info = lstat($path);
        if (!$info || ($info['mode'] & 0170000) !== 0100000 || ($info['mode'] & 0077) !== 0
            || $info['nlink'] !== 1 || !is_writable($path)
            || (function_exists('posix_geteuid') && $info['uid'] !== posix_geteuid())) {
            throw new \RuntimeException('Unsafe captcha database');
        }
        return new self(new PDO('sqlite:' . $path));
    }

    /** @return array{id:string, code:string} Plaintext code stays inside the renderer. */
    public function issue(string $scene, string $ip, ?int $now = null): array
    {
        if (!in_array($scene, self::SCENES, true) || filter_var($ip, FILTER_VALIDATE_IP) === false) {
            throw new \InvalidArgumentException('Invalid captcha scene or client address');
        }
        $now ??= time();
        return $this->transaction(function () use ($scene, $ip, $now): array {
            $this->db->prepare('DELETE FROM challenges WHERE expires_at <= ?')->execute([$now]);
            $ipHash = hash('sha256', $ip);
            $count = $this->db->prepare('SELECT COUNT(*) FROM challenges WHERE ip_hash = ?');
            $count->execute([$ipHash]);
            if ((int)$count->fetchColumn() >= 60
                || (int)$this->db->query('SELECT COUNT(*) FROM challenges')->fetchColumn() >= 10000) {
                throw new \OverflowException('Captcha generation limit reached');
            }
            $id = rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
            $code = '';
            for ($i = 0; $i < 4; $i++) $code .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
            $this->db->prepare('INSERT INTO challenges(id, scene, ip_hash, answer_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([$id, $scene, $ipHash, hash('sha256', $id . "\0" . $code), $now + self::TTL]);
            return ['id' => $id, 'code' => $code];
        });
    }

    public function consume(mixed $id, mixed $code, string $scene, string $ip, ?int $now = null): bool
    {
        if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{22}$/D', $id)
            || !is_string($code) || strlen($code) > 32
            || !in_array($scene, self::SCENES, true) || filter_var($ip, FILTER_VALIDATE_IP) === false) {
            return false;
        }
        $now ??= time();
        return $this->transaction(function () use ($id, $code, $scene, $ip, $now): bool {
            $query = $this->db->prepare('SELECT answer_hash FROM challenges
                WHERE id = ? AND scene = ? AND ip_hash = ? AND expires_at > ? AND answer_hash IS NOT NULL');
            $query->execute([$id, $scene, hash('sha256', $ip), $now]);
            $expected = $query->fetchColumn();
            if ($expected === false) return false;
            // Keep the row until expiry so successful/bad guesses cannot reset rate accounting.
            $this->db->prepare('UPDATE challenges SET answer_hash = NULL WHERE id = ?')->execute([$id]);
            return hash_equals($expected, hash('sha256', $id . "\0" . strtoupper(trim($code))));
        });
    }

    private function transaction(callable $operation): mixed
    {
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $result = $operation();
            $this->db->exec('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            try {
                $this->db->exec('ROLLBACK');
            } catch (\Throwable) {
                // Preserve the original storage error, not a secondary rollback failure.
            }
            throw $error;
        }
    }
}
