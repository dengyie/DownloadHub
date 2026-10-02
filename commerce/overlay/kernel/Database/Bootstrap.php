<?php
declare(strict_types=1);

namespace Kernel\Database;

use Illuminate\Database\Capsule\Manager;
use Illuminate\Database\SQLiteConnection;

final class Bootstrap
{
    public static function boot(array $config): Manager
    {
        $capsule = new Manager();
        if (($config['driver'] ?? '') === 'sqlite') {
            $capsule->getDatabaseManager()->extend('sqlite', static function (array $settings) {
                return new SQLiteConnection(
                    new ImmediatePDO($settings['database'], (int)($settings['busy_timeout'] ?? 5000)),
                    $settings['database'], $settings['prefix'] ?? '', $settings
                );
            });
        }
        $config['options'][\PDO::ATTR_PERSISTENT] = false;
        $capsule->addConnection($config);
        $capsule->setAsGlobal();
        $capsule->bootEloquent();
        return $capsule;
    }
}
