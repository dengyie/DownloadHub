<?php
declare(strict_types=1);

// Run directly: php commerce/tests/storefront.php
// These in-memory stubs deliberately avoid the application bootstrap, database, and autoloader.
namespace StorefrontTest {
    final class State
    {
        public static array $headers = [];
        public static int $status = 418;
        public static string $domain = 'shop.example.invalid';
        public static ?\App\Model\User $user = null;
        public static ?\App\Model\UserGroup $group = null;
        public static int $userReads = 0;
        public static int $groupReads = 0;
    }

    class Record implements \JsonSerializable
    {
        public function __construct(private array $fields) {}

        public function __get(string $name): mixed
        {
            if (!array_key_exists($name, $this->fields)) {
                throw new \RuntimeException('Unexpected model field read: ' . $name);
            }
            return $this->fields[$name];
        }

        public function toArray(): array
        {
            throw new \RuntimeException('Full model conversion is forbidden');
        }

        public function jsonSerialize(): mixed
        {
            throw new \RuntimeException('Full model serialization is forbidden');
        }
    }
}

namespace App\Model {
    final class Config
    {
        public const PUBLIC_KEYS = [
            'shop_name', 'title', 'notice', 'service_url', 'closed', 'default_category',
            'registered_state', 'registered_type', 'registered_verification',
            'registered_email_verification', 'registered_phone_verification',
            'login_verification', 'username_len', 'forget_type',
        ];
        public static array $values = [];
        public static array $reads = [];

        public static function get(string $key): string
        {
            if (!in_array($key, self::PUBLIC_KEYS, true)) {
                throw new \RuntimeException('Non-public configuration read: ' . $key);
            }
            self::$reads[] = $key;
            return (string)(self::$values[$key] ?? '');
        }
    }

    class User extends \StorefrontTest\Record {}
    class UserGroup extends \StorefrontTest\Record {}

    class Business extends \StorefrontTest\Record
    {
        public static array $sites = [];
        public static array $queries = [];

        public static function query(): BusinessQuery
        {
            return new BusinessQuery();
        }
    }

    final class BusinessQuery
    {
        private string $column = '';
        private string $domain = '';

        public function where(string $column, string $domain): self
        {
            if (!in_array($column, ['subdomain', 'topdomain'], true)) {
                throw new \RuntimeException('Unexpected business lookup');
            }
            $this->column = $column;
            $this->domain = $domain;
            return $this;
        }

        public function first(array $columns = ['*']): ?Business
        {
            $public = ['shop_name', 'title', 'notice', 'service_url', 'service_qq', 'user_id'];
            if (array_diff($columns, $public) !== []) {
                throw new \RuntimeException('Non-public business projection');
            }
            Business::$queries[] = [$this->column, $this->domain];
            foreach (Business::$sites as $site) {
                if (($site[$this->column] ?? null) === $this->domain) {
                    return new Business(array_intersect_key($site, array_flip($columns)));
                }
            }
            return null;
        }
    }
}

namespace App\Controller\Base\API {
    abstract class User
    {
        // Preserve the real protected helper signature, including nullable data.
        protected function json(int $code = 200, ?string $message = null, ?array $data = []): array
        {
            $result = ['code' => $code];
            if ($message) {
                $result['msg'] = $message;
            }
            $result['data'] = $data;
            return $result;
        }

        protected function getUser(): ?\App\Model\User
        {
            \StorefrontTest\State::$userReads++;
            return \StorefrontTest\State::$user;
        }

        protected function getUserGroup(): ?\App\Model\UserGroup
        {
            \StorefrontTest\State::$groupReads++;
            return \StorefrontTest\State::$group;
        }
    }
}

namespace App\Util {
    final class Client
    {
        public static function getDomain(): string
        {
            return \StorefrontTest\State::$domain;
        }
    }
}

namespace App\Interceptor {
    final class Waf {}
    final class UserVisitor {}
}

namespace Kernel\Annotation {
    #[\Attribute(\Attribute::TARGET_CLASS)]
    final class Interceptor
    {
        public const TYPE_API = 1;

        public function __construct(public array $interceptors, public int $type = 0) {}
    }
}

namespace App\Controller\User\Api {
    // Capture the actual controller's header calls even under the CLI SAPI.
    function header(string $header): void
    {
        [$name, $value] = explode(':', $header, 2);
        \StorefrontTest\State::$headers[strtolower($name)] = trim($value);
    }

    function http_response_code(int $code): int
    {
        \StorefrontTest\State::$status = $code;
        return $code;
    }
}

namespace {
    use App\Controller\User\Api\Storefront;
    use App\Model\Business;
    use App\Model\Config;
    use App\Util\StorefrontPayload;
    use StorefrontTest\State;

    require __DIR__ . '/../overlay/app/Util/StorefrontPayload.php';
    require __DIR__ . '/../overlay/app/Controller/User/Api/Storefront.php';

    set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
        throw new ErrorException($message, 0, $severity, $file, $line);
    });

    $assertions = 0;
    function same(mixed $expected, mixed $actual, string $message): void
    {
        global $assertions;
        $assertions++;
        if ($expected !== $actual) {
            throw new RuntimeException($message . "\nExpected: " . var_export($expected, true)
                . "\nActual: " . var_export($actual, true));
        }
    }

    function resetController(string $method = 'GET'): void
    {
        State::$headers = [];
        State::$status = 418;
        State::$domain = 'shop.example.invalid';
        State::$user = null;
        State::$group = null;
        State::$userReads = State::$groupReads = 0;
        Config::$values = Config::$reads = [];
        Business::$sites = Business::$queries = [];
        $_GET = $_POST = [];
        $_SERVER['REQUEST_METHOD'] = $method;
    }

    function verifyHeaders(): void
    {
        same('application/json; charset=utf-8', State::$headers['content-type'] ?? null, 'JSON content type');
        same('no-store', State::$headers['cache-control'] ?? null, 'Session response must not be cached');
    }

    if (($argv[1] ?? '') === '--head') {
        resetController('HEAD');
        register_shutdown_function(static function (): void {
            try {
                verifyHeaders();
                same(200, State::$status, 'HEAD status');
                same([], Config::$reads, 'HEAD must exit before configuration reads');
                same([], Business::$queries, 'HEAD must exit before business queries');
                same(0, State::$userReads, 'HEAD must exit before member projection');
                fwrite(STDERR, "HEAD verified\n");
            } catch (Throwable $error) {
                fwrite(STDERR, $error->getMessage() . "\n");
                exit(1);
            }
        });
        (new Storefront())->bootstrap();
        fwrite(STDERR, "HEAD returned to the kernel\n");
        exit(1);
    }

    $defaults = [
        'name' => '', 'title' => '', 'notice' => '', 'support_url' => '',
        'closed' => false, 'default_category' => 0, 'from' => 0,
        'auth' => [
            'registration_enabled' => false, 'registration_type' => 0,
            'registration_captcha' => false, 'email_verification' => false,
            'phone_verification' => false, 'login_captcha' => false,
            'username_min_length' => 6, 'recovery_type' => 0,
        ],
        'user' => null,
    ];
    same($defaults, StorefrontPayload::build([]), 'Missing configuration produces a complete guest payload');

    $secrets = [
        'password' => 'PRIVATE_PASSWORD', 'salt' => 'PRIVATE_SALT', 'app_key' => 'PRIVATE_APP_KEY',
        'email' => 'PRIVATE_EMAIL', 'phone' => 'PRIVATE_PHONE', 'smtp_password' => 'PRIVATE_SMTP',
        'coin' => 'PRIVATE_COIN', 'recharge' => 'PRIVATE_RECHARGE', 'discount_config' => ['PRIVATE_DISCOUNT'],
        'orders' => [['secret' => 'PRIVATE_CARD']], 'config' => [['key' => 'PRIVATE_CONFIG_ROW']],
    ];
    $config = [
        'shop_name' => '下载商店', 'title' => 'Store title', 'notice' => '<p>New downloads</p>',
        'service_url' => '/support?source=store', 'closed' => '0', 'default_category' => '12',
        'registered_state' => '1', 'registered_type' => '2', 'registered_verification' => '1',
        'registered_email_verification' => '1', 'registered_phone_verification' => '0',
        'login_verification' => '1', 'username_len' => '8', 'forget_type' => '0',
    ] + $secrets;
    $guest = [
        'name' => '下载商店', 'title' => 'Store title', 'notice' => '<p>New downloads</p>',
        'support_url' => '/support?source=store', 'closed' => false, 'default_category' => 12, 'from' => 42,
        'auth' => [
            'registration_enabled' => true, 'registration_type' => 2,
            'registration_captcha' => true, 'email_verification' => true,
            'phone_verification' => false, 'login_captcha' => true,
            'username_min_length' => 8, 'recovery_type' => 0,
        ],
        'user' => null,
    ];
    same($guest, StorefrontPayload::build($config, null, null, ['from' => '0042'] + $secrets),
        'Guest fields, email verification, numeric promotion and configuration filtering');

    $phone = StorefrontPayload::build(array_replace($config, [
        'registered_type' => '1', 'registered_email_verification' => '0',
        'registered_phone_verification' => '1', 'forget_type' => '1',
    ]));
    same(1, $phone['auth']['registration_type'], 'Phone registration mode');
    same(false, $phone['auth']['email_verification'], 'Disabled email verification');
    same(true, $phone['auth']['phone_verification'], 'Phone verification');
    same(1, $phone['auth']['recovery_type'], 'Phone recovery mode');
    same(0, StorefrontPayload::build(['registered_type' => '0'])['auth']['registration_type'], 'Username registration mode');
    $disabled = StorefrontPayload::build(array_replace($config, ['registered_state' => '0', 'closed' => '1']));
    same(false, $disabled['auth']['registration_enabled'], 'Disabled registration stays disabled');
    same(true, $disabled['auth']['registration_captcha'], 'Independent verification settings remain available');
    same(true, $disabled['closed'], 'Closed flag');
    $both = StorefrontPayload::build(['registered_email_verification' => '1', 'registered_phone_verification' => '1']);
    same(true, $both['auth']['email_verification'] && $both['auth']['phone_verification'], 'Both verification flags are preserved');

    $member = ['id' => '7', 'username' => 'reader', 'avatar' => '/avatars/member.png',
        'balance' => '12.50', 'group_name' => 'VIP'] + $secrets;
    $publicMember = ['id' => 7, 'username' => 'reader', 'avatar' => '/avatars/member.png',
        'balance' => 12.5, 'group_name' => 'VIP'];
    $memberPayload = StorefrontPayload::build($config, null, $member);
    same($publicMember, $memberPayload['user'], 'Member projection uses balance and excludes all internal fields');
    same(false, str_contains(json_encode($memberPayload, JSON_THROW_ON_ERROR), 'PRIVATE_'), 'No private value is serialized');
    same(null, StorefrontPayload::build([], null, [])['user'], 'A member without an ID is a guest');
    same(null, StorefrontPayload::build([], null, ['id' => -1])['user'], 'An invalid member ID is a guest');
    same('', StorefrontPayload::build([], null, ['id' => 1])['user']['group_name'], 'Missing member group');
    foreach ([null, [], new stdClass(), 'not-a-number', '1e9999', INF, NAN, -1] as $invalidBalance) {
        same(0.0, StorefrontPayload::build([], null, ['id' => 1, 'balance' => $invalidBalance])['user']['balance'],
            'Malformed balance cannot break JSON serialization');
    }

    $business = [
        'shop_name' => 'Branch shop', 'title' => 'Branch title', 'notice' => '<p>Branch notice</p>',
        'service_url' => 'https://support.example.invalid/help', 'service_qq' => '123456',
        'user_id' => '81', 'registered_state' => '0', 'closed' => '1',
    ] + $secrets;
    $businessPayload = StorefrontPayload::build($config, $business, $member);
    same('Branch shop', $businessPayload['name'], 'Business name override');
    same('Branch title', $businessPayload['title'], 'Business title override');
    same('<p>Branch notice</p>', $businessPayload['notice'], 'Business notice override');
    same('https://support.example.invalid/help', $businessPayload['support_url'], 'Business support override');
    same(81, $businessPayload['from'], 'Business owner supplies missing promotion');
    same($guest['auth'], $businessPayload['auth'], 'Business fields cannot override global authentication settings');
    same(false, $businessPayload['closed'], 'Business fields cannot override the global closed flag');
    same(false, str_contains(json_encode($businessPayload, JSON_THROW_ON_ERROR), 'PRIVATE_'), 'Business model secrets are filtered');
    same(42, StorefrontPayload::build($config, $business, null, ['from' => '42'])['from'], 'Explicit promotion wins over business owner');
    same(81, StorefrontPayload::build($config, $business, null, ['from' => '0'])['from'], 'Zero promotion uses business owner');
    $qqBusiness = array_replace($business, ['service_url' => '']);
    same('https://wpa.qq.com/msgrd?v=1&uin=123456', StorefrontPayload::build($config, $qqBusiness)['support_url'], 'Business QQ support fallback');
    same('', StorefrontPayload::build($config, array_replace($qqBusiness, ['service_qq' => '123&url=evil']))['support_url'], 'QQ contact cannot inject a query');
    same('', StorefrontPayload::build($config, array_replace($business, ['shop_name' => '']))['name'], 'An intentional empty business override is preserved');

    $safeLinks = [
        '/support', '/', '/files/read%20me.pdf?x=1#help', '/path/user@example.invalid',
        'https://example.invalid/help?x=1&y=2', 'HTTP://example.invalid:8080/help',
        'https://[::1]/support',
    ];
    foreach ($safeLinks as $url) {
        $payload = StorefrontPayload::build(['service_url' => $url], null, ['id' => 1, 'avatar' => $url]);
        same($url, $payload['support_url'], 'Safe support URL');
        same($url, $payload['user']['avatar'], 'Safe avatar URL');
    }
    $unsafeLinks = [
        null, 42, true, [], new stdClass(), '', 'javascript:alert(1)', 'data:text/html,evil',
        'mailto:support@example.invalid', 'ftp://example.invalid/file', 'support/help',
        '//evil.example', '///evil.example', '\\evil.example', '/\\evil.example',
        'https://example.invalid\\@evil.example', 'https://user:password@example.invalid',
        'https://user@example.invalid', 'https://@example.invalid', 'https:/example.invalid',
        'https:///example.invalid', 'https://example.invalid:99999/', ' https://example.invalid',
        "https://example.invalid/\r\nInjected: true", "/help\tmore", "/help\0more",
        "/help\u{0085}more", "/help\u{200B}more", '/%2Fevil.example', '/%5cevil.example',
        'https://example.invalid/%0a', '/help%7fmore', "https://example.invalid/\xFF",
    ];
    foreach ($unsafeLinks as $url) {
        $payload = StorefrontPayload::build(['service_url' => $url], null, ['id' => 1, 'avatar' => $url]);
        same('', $payload['support_url'], 'Unsafe support URL is removed');
        same('', $payload['user']['avatar'], 'Unsafe avatar URL is removed');
        same('', StorefrontPayload::build($config, ['service_url' => $url])['support_url'], 'Business URLs use the same validation');
    }

    $poison = new class implements Stringable {
        public function __toString(): string
        {
            throw new RuntimeException('Unexpected conversion of an internal object');
        }
    };
    $invalid = [
        'shop_name' => $secrets, 'title' => $poison, 'notice' => "\xFF", 'service_url' => $poison,
        'closed' => 'yes', 'default_category' => '999999999999999999999999999999',
        'registered_state' => ['1'], 'registered_type' => '3', 'registered_verification' => 'true',
        'registered_email_verification' => $poison, 'registered_phone_verification' => -1,
        'login_verification' => '1oops', 'username_len' => '33', 'forget_type' => '2',
    ];
    same($defaults, StorefrontPayload::build($invalid), 'Malformed configuration cannot leak objects or produce invalid JSON');
    foreach ([0, -1, '0', '33', '', null, [], $poison, '1e1', 1.5] as $invalidLength) {
        same(6, StorefrontPayload::build(['username_len' => $invalidLength])['auth']['username_min_length'], 'Invalid username length default');
    }
    foreach ([1, '32'] as $length) {
        same((int)$length, StorefrontPayload::build(['username_len' => $length])['auth']['username_min_length'], 'Username length boundaries');
    }
    foreach ([null, [], $poison, true, -1, '-1', '2.5', '1e2', '12junk', ' 12', '999999999999999999999999999999'] as $from) {
        same(0, StorefrontPayload::build([], null, null, ['from' => $from])['from'], 'Invalid promotion defaults to zero');
    }
    same(PHP_INT_MAX, StorefrontPayload::build([], null, null, ['from' => (string)PHP_INT_MAX])['from'], 'Promotion integer boundary');
    $invalidMember = StorefrontPayload::build([], null, ['id' => 1, 'username' => "\xFF", 'avatar' => $poison, 'group_name' => $secrets]);
    same('', $invalidMember['user']['username'], 'Invalid UTF-8 is removed');
    json_encode($invalidMember, JSON_THROW_ON_ERROR);

    $reflection = new ReflectionClass(Storefront::class);
    same(true, $reflection->isSubclassOf(App\Controller\Base\API\User::class), 'Existing base API user is reused');
    $interceptors = $reflection->getAttributes(Kernel\Annotation\Interceptor::class);
    same(1, count($interceptors), 'Visitor interceptor attribute exists');
    $interceptor = $interceptors[0]->newInstance();
    same([App\Interceptor\Waf::class, App\Interceptor\UserVisitor::class], $interceptor->interceptors, 'Existing WAF and visitor session detection');
    same(Kernel\Annotation\Interceptor::TYPE_API, $interceptor->type, 'API interceptor error behavior');

    resetController();
    Config::$values = $config;
    $_GET = ['from' => '0042'];
    $_POST = ['from' => '999'];
    $response = (new Storefront())->bootstrap();
    same(['code' => 200, 'data' => $guest], $response, 'Actual controller guest envelope and query-only promotion');
    same(200, State::$status, 'GET status');
    verifyHeaders();
    same(Config::PUBLIC_KEYS, Config::$reads, 'Only public configuration is read');
    same(0, State::$groupReads, 'Guest does not query a member group');

    resetController();
    Config::$values = $config;
    State::$user = new App\Model\User(['id' => 7, 'username' => 'reader', 'avatar' => '/avatars/member.png', 'balance' => 12.5]);
    State::$group = new App\Model\UserGroup(['name' => 'VIP']);
    same($publicMember, (new Storefront())->bootstrap()['data']['user'], 'Actual controller member projection');
    same(1, State::$groupReads, 'Existing group lookup supplies only the group name');
    State::$group = null;
    same('', (new Storefront())->bootstrap()['data']['user']['group_name'], 'Actual controller tolerates a missing group');

    resetController();
    Config::$values = $config;
    Business::$sites = [
        $business + ['subdomain' => State::$domain],
        array_replace($business, ['shop_name' => 'Topdomain shop', 'topdomain' => State::$domain]),
    ];
    same('Branch shop', (new Storefront())->bootstrap()['data']['name'], 'Subdomain match has precedence');
    same([['subdomain', State::$domain]], Business::$queries, 'Topdomain query is skipped after a subdomain match');
    resetController();
    Config::$values = $config;
    Business::$sites = [$qqBusiness + ['topdomain' => State::$domain]];
    $response = (new Storefront())->bootstrap();
    same(81, $response['data']['from'], 'Actual controller business promotion fallback');
    same('https://wpa.qq.com/msgrd?v=1&uin=123456', $response['data']['support_url'], 'Actual controller business support fallback');
    same([['subdomain', State::$domain], ['topdomain', State::$domain]], Business::$queries, 'Topdomain fallback lookup');

    foreach (['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get', ''] as $method) {
        resetController($method);
        $response = (new Storefront())->bootstrap();
        same(405, State::$status, 'Unsupported method HTTP status');
        same(['code' => 405, 'msg' => 'Method not allowed', 'data' => []], $response, 'Unsupported method JSON envelope');
        same('GET, HEAD', State::$headers['allow'] ?? null, 'Allowed methods header');
        verifyHeaders();
        same([], Config::$reads, 'Method guard runs before configuration reads');
        same([], Business::$queries, 'Method guard runs before business queries');
        same(0, State::$userReads, 'Method guard runs before member projection');
    }

    // A child process proves that the controller itself terminates HEAD without a body.
    $process = proc_open([PHP_BINARY, '-n', __FILE__, '--head'], [
        0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w'],
    ], $pipes);
    if (!is_resource($process)) {
        throw new RuntimeException('Could not start the isolated HEAD check');
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    same(0, proc_close($process), 'HEAD subprocess exit status: ' . $stderr);
    same('', $stdout, 'HEAD emits no body');
    same("HEAD verified\n", $stderr, 'HEAD header and termination checks');

    echo "PASS: storefront presenter and controller contract ({$assertions} assertions)\n";
}
