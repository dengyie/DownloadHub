<?php
declare(strict_types=1);

namespace App\Util;

use Kernel\Exception\JSONException;

/** Protocol adapted from xianyu-auto-bot login captcha; no PHP session dependency. */
final class Captcha
{
    public static function generate(string $scene): void
    {
        if (!in_array($scene, CaptchaStore::SCENES, true)) {
            throw new \InvalidArgumentException('Unknown captcha scene');
        }
        $ip = Client::getAddress();
        if ($ip === '') throw new \RuntimeException('Captcha client address unavailable');
        $challenge = CaptchaStore::open()->issue($scene, $ip);
        $png = self::render($challenge['code']);
        header('Content-Type: image/png');
        header('X-Captcha-Id: ' . $challenge['id']);
        header('Content-Length: ' . strlen($png));
        echo $png;
    }

    public static function check(mixed $id, mixed $code, string $scene): bool
    {
        if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{22}$/D', $id)
            || !is_string($code) || strlen($code) > 32) return false;
        try {
            return CaptchaStore::open()->consume($id, $code, $scene, Client::getAddress());
        } catch (\RuntimeException $error) {
            // Neither the answer/ID nor filesystem details belong in a public response.
            error_log('Captcha verification storage unavailable (' . get_class($error) . ')');
            throw new JSONException('验证码服务暂时不可用，请稍后重试', 503, $error);
        }
    }

    private static function render(string $code): string
    {
        $image = imagecreatetruecolor(150, 50);
        try {
            $white = imagecolorallocate($image, 255, 255, 255);
            imagefill($image, 0, 0, $white);
            $line = imagecolorallocate($image, 218, 224, 230);
            for ($i = 0; $i < 3; $i++) {
                imageline($image, random_int(0, 40), random_int(3, 47), random_int(110, 149), random_int(3, 47), $line);
            }
            for ($i = 0; $i < 4; $i++) {
                $glyph = imagecreatetruecolor(9, 15);
                $large = $rotated = null;
                try {
                    imagefill($glyph, 0, 0, imagecolorallocate($glyph, 255, 255, 255));
                    $ink = imagecolorallocate($glyph, random_int(25, 65), random_int(35, 70), random_int(45, 90));
                    imagestring($glyph, 5, 0, 0, $code[$i], $ink);
                    $large = imagescale($glyph, 20, 32, IMG_BICUBIC);
                    $rotated = imagerotate($large, random_int(-10, 10), $white);
                    imagecopy($image, $rotated, 12 + $i * 32, random_int(5, 10), 0, 0, imagesx($rotated), imagesy($rotated));
                } finally {
                    imagedestroy($glyph);
                    if ($large) imagedestroy($large);
                    if ($rotated) imagedestroy($rotated);
                }
            }
            ob_start();
            try {
                if (!imagepng($image)) throw new \RuntimeException('Captcha image encoding failed');
                return (string)ob_get_contents();
            } finally {
                ob_end_clean();
            }
        } finally {
            imagedestroy($image);
        }
    }
}
