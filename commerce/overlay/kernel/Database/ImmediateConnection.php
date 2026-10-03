<?php
declare(strict_types=1);

namespace Kernel\Database;

use Closure;
use Illuminate\Database\SQLiteConnection;
use LogicException;
use Throwable;

/** Keeps Illuminate's savepoint depth consistent with SQLite's engine state. */
final class ImmediateConnection extends SQLiteConnection
{
    private ?Throwable $transactionFailure = null;
    private int $callbackDepth = 0;

    public function transaction(Closure $callback, $attempts = 1)
    {
        $this->assertTransactionUsable();
        $level = $this->transactionLevel();
        $this->callbackDepth++;
        try {
            $this->beginTransaction();
            // Do not replay callbacks: order/payment callbacks may have effects
            // outside SQLite, regardless of the framework's attempts argument.
            $result = $callback($this);
            $this->assertTransactionUsable();
            if ($this->transactionLevel() !== $level + 1) {
                throw new LogicException('Transaction callback changed its transaction boundary');
            }
            $this->commit();
            return $result;
        } catch (Throwable $failure) {
            $original = $this->transactionFailure ?? $failure;
            if ($this->transactionLevel() > $level) {
                try {
                    $this->rollBack($level);
                } catch (Throwable $cleanupFailure) {
                    // A failed rollback must not replace the statement/business
                    // error, and no parent callback may keep using this session.
                    $this->invalidateTransaction($original);
                }
            }
            throw $original;
        } finally {
            $this->callbackDepth--;
            if ($this->callbackDepth === 0 && $level === 0) {
                $this->transactionFailure = null;
            }
        }
    }

    public function beginTransaction()
    {
        $this->assertTransactionUsable();
        try {
            parent::beginTransaction();
        } catch (Throwable $failure) {
            if ($this->transactionLevel() > 0) {
                $this->invalidateTransaction($failure);
            }
            throw $failure;
        }
    }

    public function commit()
    {
        if ($this->transactionFailure !== null) {
            $failure = $this->transactionFailure;
            if ($this->callbackDepth === 0) {
                $this->transactionFailure = null;
            }
            throw $failure;
        }
        try {
            parent::commit();
        } catch (Throwable $failure) {
            $this->invalidateTransaction($failure);
            if ($this->callbackDepth === 0) {
                $this->transactionFailure = null;
            }
            throw $failure;
        }
    }

    public function rollBack($toLevel = null)
    {
        if ($this->transactionFailure !== null) {
            // Invalidation has already rolled back/disconnected the whole
            // transaction. A manual caller acknowledges failure with rollback.
            if ($this->callbackDepth === 0) {
                $this->transactionFailure = null;
            }
            return;
        }
        try {
            parent::rollBack($toLevel);
        } catch (Throwable $failure) {
            $this->invalidateTransaction($failure);
            if ($this->callbackDepth === 0) {
                $this->transactionFailure = null;
            }
            throw $failure;
        }
    }

    public function getPdo()
    {
        $this->assertTransactionUsable();
        return parent::getPdo();
    }

    protected function run($query, $bindings, Closure $callback)
    {
        // In particular, prevent a swallowed inner exception from causing
        // subsequent writes to run in autocommit on a fresh connection.
        $this->assertTransactionUsable();
        return parent::run($query, $bindings, $callback);
    }

    protected function runQueryCallback($query, $bindings, Closure $callback)
    {
        $this->assertTransactionUsable();
        try {
            return parent::runQueryCallback($query, $bindings, $callback);
        } catch (Throwable $failure) {
            if ($this->transactionLevel() > 0) {
                $alive = false;
                try {
                    $pdo = $this->getPdo();
                    $alive = $pdo instanceof ImmediatePDO && $pdo->refreshTransactionState();
                } catch (Throwable $probeFailure) {
                    // Preserve the original query error on an uncertain state.
                }
                if (!$alive) {
                    $this->invalidateTransaction($failure);
                }
            }
            throw $failure;
        }
    }

    private function assertTransactionUsable(): void
    {
        if ($this->transactionFailure !== null) {
            throw $this->transactionFailure;
        }
    }

    private function invalidateTransaction(Throwable $failure): void
    {
        $pdo = $this->getRawPdo();
        if ($pdo instanceof ImmediatePDO && $pdo->inTransaction()) {
            try {
                $pdo->rollBack();
            } catch (Throwable $cleanupFailure) {
                // Dropping the uncertain session also resets framework depth.
            }
        }
        parent::disconnect();
        $this->transactionFailure = $failure;
    }
}
