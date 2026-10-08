<?php
declare(strict_types=1);

// Exercise the real controllers/store/rendering with business-service doubles.
// No customer DB, real credentials, SSO session, email, SMS or payment is used.
namespace CaptchaCallerTest {
    final class State
    {
        public static array $headers = [];
        public static int $status = 200;
    }
    function saveHeader(string $header): void
    {
        [$key, $value] = explode(':', $header, 2);
        State::$headers[strtolower($key)] = trim($value);
    }
}
namespace Kernel\Context\Interface {
    class Request
    {
        public function __construct(public array $fields = []) {}
        public function post(?string $key = null, int $flags = 0): mixed {return $key === null ? $this->fields : ($this->fields[$key] ?? null);}
        public function header(string $key): string {return 'Codex';}
    }
}
namespace App\Controller\Base\API {
    class User
    {
        public function __construct(public \Kernel\Context\Interface\Request $request) {}
        protected function json(int $code = 200, ?string $msg = null, ?array $data = []): array {return compact('code', 'msg', 'data');}
        protected function getUser(): mixed {return null;}
        protected function getUserGroup(): mixed {return null;}
    }
    class Manage extends User {}
}
namespace App\Model {
    class Config
    {
        public static array $values = [];
        public static function get(string $key): mixed {return self::$values[$key] ?? '';}
    }
}
namespace App\Util {
    function header(string $value): void {\CaptchaCallerTest\saveHeader($value);}
    class Client
    {
        public static function getAddress(): string {return '192.0.2.44';}
        public static function getDeviceTypeByUa(string $ua): int {return 0;}
    }
    class Validation
    {
        public static function username(string $value, int $min): bool {return false;}
        public static function password(string $value): bool {return strlen($value) >= 6;}
        public static function email(string $value): bool {return str_contains($value, '@');}
        public static function phone(string $value): bool {return strlen($value) === 11;}
    }
    class Throttle
    {
        public static bool $blocked = false;
        public static array $calls = [];
        public static function tooMany(string $key, int $limit, int $window): bool {self::$calls[] = [$key, $limit, $window]; return self::$blocked;}
        public static function clear(string $key): void {self::$calls[] = ['clear', $key];}
    }
}
namespace App\Service {
    class ManageSSO
    {
        public array $calls = [];
        public function login(string $username, string $password, bool $remember, string $code): array
        {
            $this->calls[] = compact('username', 'password', 'remember', 'code');
            return [];
        }
    }
    class Order
    {
        public array $calls = [];
        public function trade(mixed $user, mixed $group, array $map): array {$this->calls[] = $map; return ['tradeNo' => '202610090000000001'];}
    }
    class Email
    {
        public const CAPTCHA_FORGET = 2;
        public array $calls = [];
        public function checkCaptcha(string $target, int $type, int $code): bool {$this->calls[] = [$target, $type, $code]; return false;}
    }
    class Sms extends Email {}
}
namespace App\Controller\User {
    function header(string $value): void {\CaptchaCallerTest\saveHeader($value);}
    function http_response_code(int $code): void {\CaptchaCallerTest\State::$status = $code;}
}
namespace {
    require __DIR__ . '/bootstrap.php';
    function hook(mixed ...$args): void {}
    $assertions = 0;
    function check(bool $condition, string $message): void {
        global $assertions;
        $assertions++;
        if (!$condition) throw new RuntimeException($message);
    }
    function denied(callable $action, string $message): void {
        try {$action(); check(false, 'Expected refusal: ' . $message);}
        catch (\Kernel\Exception\JSONException $error) {check($error->getMessage() === $message, 'Unexpected refusal: ' . $error->getMessage());}
    }
    function inject(object $object, string $field, object $value): void {
        (new ReflectionProperty($object, $field))->setValue($object, $value);
    }
    function fields(string $scene): array {
        $challenge = \App\Util\CaptchaStore::open()->issue($scene, \App\Util\Client::getAddress());
        return ['captcha_id' => $challenge['id'], 'captcha_code' => strtolower($challenge['code'])];
    }
    $request = new \Kernel\Context\Interface\Request();
    $auth = new \App\Controller\User\Api\Authentication($request);
    $security = new \App\Controller\User\Api\Security($request);
    \App\Model\Config::$values = ['registered_state' => 1, 'registered_type' => 2, 'registered_verification' => 1, 'login_verification' => 1, 'username_len' => 3, 'forget_type' => 0];
    $cases = [
        [$auth, 'login', '用户名输入错误'], [$auth, 'register', '用户名最少3位'],
        [$auth, 'emailRegisterCaptcha', '邮箱地址不正确'], [$auth, 'emailForgetCaptcha', '邮箱地址不正确'],
        [$auth, 'phoneRegisterCaptcha', '手机号码不正确'], [$auth, 'phoneForgetCaptcha', '手机号码不正确'],
        [$security, 'emailBindNew', '邮箱地址不正确'], [$security, 'phoneBindNew', '手机号码不正确'],
    ];
    foreach ($cases as [$controller, $scene, $nextValidation]) {
        if (str_starts_with($scene, 'phone')) {\App\Model\Config::$values['registered_type'] = 1; \App\Model\Config::$values['forget_type'] = 1;}
        $_POST = ['captcha' => '4286'];
        denied(fn() => $controller->$scene(), '验证码错误');
        $_POST = ['captcha_id' => [], 'captcha_code' => []];
        denied(fn() => $controller->$scene(), '验证码错误');
        $_POST = fields($scene);
        denied(fn() => $controller->$scene(), $nextValidation);
        denied(fn() => $controller->$scene(), '验证码错误');
    }
    \App\Model\Config::$values['login_verification'] = 0;
    $_POST = [];
    denied(fn() => $auth->login(), '用户名输入错误');

    // The reset-password endpoint still consumes a received business code, not a graphic code.
    foreach (['email', 'phone'] as $channel) {
        $service = $channel === 'email' ? new \App\Service\Email() : new \App\Service\Sms();
        inject($auth, $channel === 'email' ? 'email' : 'sms', $service);
        \App\Model\Config::$values['forget_type'] = $channel === 'email' ? 0 : 1;
        $target = $channel === 'email' ? 'fixture@example.test' : '13800138000';
        $_POST = ['username' => $target, 'password' => 'fixture-password', 'captcha' => '123456', 'captcha_code' => 'ABCD'];
        denied(fn() => $auth->password(), $channel === 'email' ? '邮箱验证码不正确' : '手机验证码不正确');
        check($service->calls === [[$target, 2, 123456]], 'Business code contract changed');
    }

    $admin = new \App\Controller\Admin\Api\Authentication($request);
    $sso = new \App\Service\ManageSSO();
    inject($admin, 'sso', $sso);
    // Unset configuration must remain enabled, even for a Codex User-Agent.
    $request->fields = [];
    denied(fn() => $admin->login('fixture', 'fixture-password'), '验证码错误');
    $request->fields = fields('adminLogin') + ['remember' => true, 'code' => '123456'];
    check($admin->login('fixture', 'fixture-password')['code'] === 200, 'Admin login gate');
    check($sso->calls[0]['code'] === '123456' && $sso->calls[0]['remember'], 'TOTP/remember must reach SSO unchanged');
    denied(fn() => $admin->login('fixture', 'fixture-password'), '验证码错误');
    \App\Model\Config::$values['admin_login_verification'] = '0';
    $request->fields = [];
    check($admin->login('fixture', 'fixture-password')['code'] === 200, 'Explicit admin captcha opt-out');
    \App\Util\Throttle::$blocked = true;
    denied(fn() => $admin->login('fixture', 'fixture-password'), '登录尝试过于频繁，请稍后再试');
    check(\App\Util\Throttle::$calls[0] === ['adminlogin:192.0.2.44', 10, 600], 'Admin throttle contract changed');

    $orders = new \App\Service\Order();
    $order = new \App\Controller\User\Api\Order($request);
    inject($order, 'order', $orders);
    \App\Model\Config::$values['trade_verification'] = 1;
    $request->fields = [];
    denied(fn() => $order->trade($request), '验证码错误');
    check($orders->calls === [], 'Invalid captcha must not create a trade');
    $request->fields = fields('trade') + ['item_id' => 101, 'num' => 2, 'sku' => ['平台' => 'macOS']];
    check($order->trade($request)['code'] === 200, 'Trade gate');
    check($orders->calls[0] === ['item_id' => 101, 'num' => 2, 'sku' => ['平台' => 'macOS'], 'device' => 0], 'Captcha secrets must not enter order hooks/services');
    denied(fn() => $order->trade($request), '验证码错误');
    check(count($orders->calls) === 1, 'Replayed captcha must not repeat trade');

    $image = new \App\Controller\User\Captcha();
    foreach (['login', 'register', 'trade', 'adminLogin'] as $scene) {
        \CaptchaCallerTest\State::$headers = [];
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_COOKIE = [];
        $_SESSION = ['login' => 'unrelated-old-session'];
        ob_start();
        $image->image($scene);
        $bytes = ob_get_clean();
        $headers = \CaptchaCallerTest\State::$headers;
        check($headers['content-type'] === 'image/png' && str_starts_with($bytes, "\x89PNG"), 'PNG response contract');
        check((bool)preg_match('/^[A-Za-z0-9_-]{22}$/D', $headers['x-captcha-id']), 'Image and ID response');
        check(str_contains($headers['cache-control'], 'no-store') && !isset($headers['set-cookie']), 'No cache or session dependence');
        check(getimagesizefromstring($bytes)[0] === 150 && getimagesizefromstring($bytes)[1] === 50, 'Readable PNG dimensions');
        check($_SESSION === ['login' => 'unrelated-old-session'], 'Image generation must not touch a session slot');
    }
    foreach ([['POST', 'login', 405], ['GET', 'unknown', 400]] as [$method, $scene, $expected]) {
        $_SERVER['REQUEST_METHOD'] = $method;
        ob_start(); $image->image($scene); $error = json_decode(ob_get_clean(), true);
        check(\CaptchaCallerTest\State::$status === $expected && $error['code'] === $expected, 'Invalid image request HTTP status');
    }
    echo "PASS captcha callers/rendering ({$assertions} assertions)\n";
}
