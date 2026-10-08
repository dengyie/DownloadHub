<?php
declare(strict_types=1);

namespace App\Controller\User;

use Kernel\Annotation\Get;

final class Captcha
{
    public function image(#[Get] string $action): void
    {
        header('Cache-Control: no-store, no-cache, must-revalidate');
        header('Pragma: no-cache');
        header('X-Content-Type-Options: nosniff');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
            header('Allow: GET');
            $this->error(405, '仅支持 GET 请求');
            return;
        }
        try {
            \App\Util\Captcha::generate($action);
        } catch (\InvalidArgumentException) {
            $this->error(400, '不支持的验证码场景');
        } catch (\OverflowException) {
            header('Retry-After: 300');
            $this->error(429, '验证码获取过于频繁，请稍后重试');
        } catch (\Throwable $error) {
            error_log('Captcha generation unavailable (' . get_class($error) . ')');
            $this->error(503, '验证码暂时无法加载，请稍后重试');
        }
    }

    private function error(int $status, string $message): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['code' => $status, 'msg' => $message], JSON_UNESCAPED_UNICODE);
    }
}
