<?php
declare(strict_types=1);

namespace App\Controller\User\Api;

use App\Controller\Base\API\User;
use App\Interceptor\UserVisitor;
use App\Interceptor\Waf;
use App\Model\Business;
use App\Model\Config;
use App\Util\Client;
use App\Util\StorefrontPayload;
use Kernel\Annotation\Interceptor;

#[Interceptor([Waf::class, UserVisitor::class], Interceptor::TYPE_API)]
class Storefront extends User
{
    private const PUBLIC_CONFIG_KEYS = [
        'shop_name', 'title', 'notice', 'service_url', 'closed', 'default_category',
        'registered_state', 'registered_type', 'registered_verification',
        'registered_email_verification', 'registered_phone_verification',
        'login_verification', 'username_len', 'forget_type',
    ];

    public function bootstrap(): array
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');

        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        if ($method !== 'GET' && $method !== 'HEAD') {
            http_response_code(405);
            header('Allow: GET, HEAD');
            return $this->json(405, 'Method not allowed');
        }

        http_response_code(200);
        if ($method === 'HEAD') {
            // Terminate before the kernel can serialize a return value or run response hooks.
            exit;
        }

        $config = [];
        foreach (self::PUBLIC_CONFIG_KEYS as $key) {
            $config[$key] = Config::get($key);
        }

        // Match Base/View/User.php: a subdomain match takes precedence over a topdomain.
        $domain = Client::getDomain();
        $columns = ['shop_name', 'title', 'notice', 'service_url', 'service_qq', 'user_id'];
        $business = Business::query()->where('subdomain', $domain)->first($columns)
            ?? Business::query()->where('topdomain', $domain)->first($columns);
        $businessData = $business === null ? null : [
            'shop_name' => $business->shop_name,
            'title' => $business->title,
            'notice' => $business->notice,
            'service_url' => $business->service_url,
            'service_qq' => $business->service_qq,
            'user_id' => $business->user_id,
        ];

        $user = $this->getUser();
        $userData = $user === null ? null : [
            'id' => $user->id,
            'username' => $user->username,
            'avatar' => $user->avatar,
            'balance' => $user->balance,
            'group_name' => $this->getUserGroup()?->name,
        ];

        return $this->json(data: StorefrontPayload::build($config, $businessData, $userData, $_GET));
    }
}
