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
