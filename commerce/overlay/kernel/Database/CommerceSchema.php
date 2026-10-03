<?php
declare(strict_types=1);

namespace Kernel\Database;

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Schema\Blueprint;

/** Explicit, additive release migration; never run DDL during HTTP requests. */
final class CommerceSchema
{
    public static function upgrade(): void
    {
        DB::transaction(static function (): void {
            $schema = DB::schema();
            if (!$schema->hasColumn('order', 'fulfillment_retry_at')) {
                $schema->table('order', static function (Blueprint $table): void {
                    $table->integer('fulfillment_retry_at')->default(0);
                    $table->index(['status', 'delivery_status', 'fulfillment_retry_at', 'id'], 'order_pending_fulfillment');
                });
            }
            if (!$schema->hasTable('order_notification')) {
                $schema->create('order_notification', static function (Blueprint $table): void {
                    $table->integer('order_id')->primary();
                    $table->integer('attempts')->default(0);
                    $table->integer('available_at')->default(0);
                    $table->integer('lease_until')->default(0);
                    $table->string('lease_token', 64)->nullable();
                    $table->integer('sent_at')->nullable();
                    $table->foreign('order_id')->references('id')->on('order')->onDelete('cascade');
                    $table->index(['sent_at', 'available_at', 'lease_until'], 'order_notification_due');
                });
            }
        });
    }
}
