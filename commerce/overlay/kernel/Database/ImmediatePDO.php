<?php
declare(strict_types=1);

namespace Kernel\Database;

use PDO;
use PDOException;
use Throwable;

/** PDO's SQLite driver does not track transactions opened by SQL BEGIN. */
final class ImmediatePDO extends PDO
{
    private bool $active = false;

    public function __construct(string $database, int $busyTimeoutMs = 5000)
    {
        if ($database !== ':memory:' && (!is_file($database) || is_link($database))) {
            throw new \InvalidArgumentException('SQLite database must already exist as a regular file');
        }
        if ($busyTimeoutMs < 0 || $busyTimeoutMs > 30000) {
            throw new \InvalidArgumentException('Invalid SQLite busy timeout');
        }
        parent::__construct('sqlite:' . $database, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_PERSISTENT => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        DecimalStorage::register($this);
        $this->exec('PRAGMA busy_timeout=' . $busyTimeoutMs);
        $mode = $this->query('PRAGMA journal_mode')->fetchColumn();
        if ($database !== ':memory:' && strtolower((string)$mode) !== 'wal') {
            throw new \RuntimeException('SQLite database must be provisioned in WAL mode');
        }
        $this->exec('PRAGMA synchronous=FULL');
        $this->exec('PRAGMA foreign_keys=ON');
        $this->exec('PRAGMA cache_size=-2048');
    }

    public function beginTransaction(): bool
    {
        if ($this->active) {
            throw new PDOException('There is already an active transaction');
        }
        $this->exec('BEGIN IMMEDIATE');
        $this->active = true;
        return true;
    }

    /**
     * Refresh the engine state after a failed statement. PDO 8.2 only remembers
     * calls to beginTransaction(), not a raw BEGIN or SQLite's automatic rollback.
     * BEGIN without a write changes no data: an existing transaction rejects it;
     * otherwise the empty probe is immediately rolled back. Never run this probe
     * on the successful query path or infer state from a limited error-code list.
     */
    public function refreshTransactionState(): bool
    {
        if (!$this->active) {
            return false;
        }
        try {
            parent::exec('BEGIN');
        } catch (PDOException $failure) {
            if ((int)($failure->errorInfo[1] ?? 0) === 1
                && str_contains($failure->getMessage(), 'cannot start a transaction within a transaction')) {
                return true;
            }
            // An ambiguous probe failure must be handled by discarding the
            // connection, never by assuming the original transaction survived.
            throw $failure;
        }
        try {
            parent::exec('ROLLBACK');
        } finally {
            $this->active = false;
        }
        return false;
    }

    public function commit(): bool
    {
        if (!$this->active) {
            throw new PDOException('There is no active transaction');
        }
        try {
            $this->exec('COMMIT');
            $this->active = false;
            return true;
        } catch (Throwable $failure) {
            // Laravel 7 decrements its nesting counter on commit failure. Do not
            // leave a pending transaction that could later commit accidentally.
            try {
                $this->rollBack();
            } catch (Throwable $ignored) {
                // Preserve the original commit error, including disk/I/O errors.
            }
            throw $failure;
        }
    }

    public function rollBack(): bool
    {
        if (!$this->active) {
            throw new PDOException('There is no active transaction');
        }
        try {
            $this->exec('ROLLBACK');
        } finally {
            $this->active = false;
        }
        return true;
    }

    public function inTransaction(): bool
    {
        return $this->active;
    }
}
