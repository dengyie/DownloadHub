#!/usr/bin/env python3
"""Consistent download-site snapshots; run once or under Supervisor."""
import argparse
from contextlib import ExitStack, closing
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time


def snapshot(config):
    os.umask(0o077)
    root = Path(config['destination'])
    root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.partial-', dir=root))
    try:
        for name, source in config['sqlite'].items():
            if Path(name).name != name:
                raise ValueError('invalid snapshot filename')
            with ExitStack() as stack:
                src = stack.enter_context(closing(sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)))
                dst = stack.enter_context(closing(sqlite3.connect(staging / name)))
                deadline = time.monotonic() + 60
                def progress(*_):
                    if time.monotonic() > deadline:
                        raise TimeoutError('SQLite backup exceeded budget')
                src.backup(dst, pages=500, progress=progress)
                if dst.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('SQLite snapshot integrity check failed')
        mysql = config.get('mysql')
        if mysql:
            command = [mysql.get('executable', 'mysqldump'),
                       '--defaults-extra-file=' + mysql['defaults_file'],
                       '--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF',
                       '--routines', '--events', '--triggers', '--databases', *mysql['databases']]
            with (staging / 'mysql.sql').open('wb') as output:
                subprocess.run(command, stdout=output, stderr=subprocess.PIPE, check=True, timeout=600)
        with tarfile.open(staging / 'files.tar.gz', 'w:gz') as archive:
            for source in config.get('files', []):
                path = Path(source).resolve(strict=True)
                archive.add(path, arcname=str(path).lstrip('/'))
        manifest = {}
        for path in staging.iterdir():
            with path.open('rb') as stream:
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                manifest[path.name] = digest.hexdigest()
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        # Flush data before atomically publishing a complete snapshot on the same filesystem.
        for path in staging.iterdir():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
        name = datetime.datetime.now(datetime.timezone.utc).strftime('snapshot-%Y%m%dT%H%M%S%f') + '-' + staging.name[-6:]
        final = root / name
        staging.rename(final)
        keep = max(1, int(config.get('retain', 28)))
        completed = sorted(p for p in root.glob('snapshot-*') if p.is_dir() and not p.is_symlink() and (p / 'manifest.json').is_file())
        previous = [path for path in completed if path != final]
        for old in previous[:max(0, len(previous) - keep + 1)]:
            shutil.rmtree(old)
        return final
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if args.once:
        try:
            print('snapshot verified:', snapshot(config), flush=True)
        except Exception as exc:
            print('snapshot failed:', type(exc).__name__, file=sys.stderr, flush=True)
            raise SystemExit(1) from None
        return
    stopped = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stopped.set())
    while not stopped.is_set():
        delay = max(60, int(config.get('interval_seconds', 21600)))
        try:
            print('snapshot verified:', snapshot(config), flush=True)
        except Exception as exc:
            # Never print commands, credential files, SQL or stderr from the database client.
            print('snapshot failed:', type(exc).__name__, flush=True)
            delay = min(delay, 300)
        stopped.wait(delay)


if __name__ == '__main__':
    main()
