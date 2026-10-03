<?php
declare(strict_types=1);

// The runner creates a private application fixture. Never fall back to a live shop.
$app = realpath(getenv('COMMERCE_TEST_APP') ?: '');
$temporaryRoot = realpath(sys_get_temp_dir());
if (!$app || !$temporaryRoot
    || !str_starts_with($app, $temporaryRoot . '/commerce-suite-')
    || !is_file($app . '/.commerce-test-fixture')
    || is_dir($app . '/config')) {
    throw new RuntimeException('Run make check-php to prepare an isolated application fixture');
}
if (!defined('BASE_PATH')) {
    define('BASE_PATH', $app . '/');
}
require BASE_PATH . 'vendor/autoload.php';
$overlay = dirname(__DIR__) . '/overlay';
spl_autoload_register(static function (string $class) use ($overlay): void {
    foreach (['Kernel\\' => 'kernel/', 'App\\' => 'app/'] as $prefix => $directory) {
        if (!str_starts_with($class, $prefix)) {
            continue;
        }
        $relative = $directory . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        foreach ([$overlay . '/', BASE_PATH] as $root) {
            if (is_file($root . $relative)) {
                require $root . $relative;
                return;
            }
        }
    }
}, true, true);
