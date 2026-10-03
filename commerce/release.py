#!/usr/bin/env python3
"""Source-only pxed release. Never restores a database or replays MySQL cutover."""
import argparse
import configparser
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path('/srv/acg-rootfs')
APP = ROOT / 'var/www/html'
SUPERVISOR = ['supervisorctl', '-c', '/personal/pxed/supervisord.conf']
SERVICES = ['acg-faka', 'commerce-maintenance', 'download-backup']


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def is_running(service):
    status = subprocess.run(SUPERVISOR + ['status', service], capture_output=True, text=True)
    fields = status.stdout.split()
    return len(fields) >= 2 and fields[1] == 'RUNNING'


def ensure_running(service):
    if not is_running(service):
        try:
            run(SUPERVISOR + ['start', service])
        except subprocess.CalledProcessError:
            if not is_running(service):
                raise


def restore_services(services):
    failures = []
    for service in services:
        try:
            ensure_running(service)
        except Exception:
            failures.append(service)
    return failures


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_sources(overlay, baseline, app=APP):
    files = {str(path.relative_to(overlay)) for path in overlay.rglob('*') if path.is_file()}
    if files != set(baseline):
        raise RuntimeError('Overlay and baseline file sets differ')
    for name, expected in baseline.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Invalid release path')
        target = app / name
        source = overlay / name
        if source.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(app.resolve()):
            raise RuntimeError('Unsafe source path: ' + name)
        if expected is None:
            if target.exists():
                raise RuntimeError('New source already exists: ' + name)
        elif not target.is_file() or digest(target) != expected:
            raise RuntimeError('Production source changed: ' + name)


def atomic_copy(source, target, owner=None):
    missing = []
    directory = target.parent
    while not directory.exists():
        missing.append(directory)
        directory = directory.parent
    for directory in reversed(missing):
        directory.mkdir()
        # Release evidence is private, but new application paths must be readable
        # by www-data even when deployment itself runs under umask 077.
        directory.chmod(0o755)
        os.chown(directory, *(owner if owner is not None else (33, 33)))
    stat = target.stat() if target.exists() else None
    fd, temporary = tempfile.mkstemp(prefix='.commerce-release-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as output, source.open('rb') as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, stat.st_mode & 0o777 if stat else 0o644)
        uid, gid = owner if owner is not None else ((stat.st_uid, stat.st_gid) if stat else (33, 33))
        os.chown(temporary, uid, gid)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_database(db):
    with closing(sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)) as connection:
        if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('SQLite integrity check failed')
        if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise RuntimeError('SQLite foreign key check failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', required=True)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    package = Path(__file__).resolve().parent
    overlay = package / 'overlay'
    baseline = json.loads((package / 'release-baseline.json').read_text())
    check_sources(overlay, baseline)
    for source in overlay.rglob('*.php'):
        run(['chroot', str(ROOT), 'php', '-l', '/' + str(source.relative_to(ROOT))], stdout=subprocess.DEVNULL)
    run(['/bin/sh', '-n', str(package / 'run-maintenance.sh')])
    configuration = configparser.ConfigParser(interpolation=None)
    configuration.read(package / 'supervisor-commerce-maintenance.conf')
    worker_settings = configuration['program:commerce-maintenance']
    if not Path(worker_settings['stdout_logfile']).parent.is_dir():
        raise RuntimeError('Worker log directory is absent')
    supervisor_lines = Path('/personal/pxed/supervisord.conf').read_text().splitlines()
    if sum(line.startswith('files = ') for line in supervisor_lines) != 1:
        raise RuntimeError('Cannot identify supervisor include list')
    db = ROOT / 'var/lib/acg-faka/shop.sqlite'
    check_database(db)
    if args.preflight_only:
        print('PASS source hashes, syntax, current SQLite integrity', flush=True)
        return
    release = Path(args.release_dir)
    release.mkdir(mode=0o700)  # Fail closed on reuse of an earlier release directory.
    original = release / 'original'
    for name, expected in baseline.items():
        if expected is not None:
            destination = original / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(APP / name, destination)
    running = []
    stopped = []
    accepting_writes = False
    mutated = False
    for service in SERVICES:
        if is_running(service):
            running.append(service)
    if 'acg-faka' not in running:
        raise RuntimeError('Storefront must be running before this release')
    try:
        for service in running:
            run(SUPERVISOR + ['stop', service])
            stopped.append(service)
        check_sources(overlay, baseline)
        run(['python3', '/personal/pxed/cardgw-backup-snapshot.py', '--config', '/personal/pxed/download-backup.json', '--once'])
        with closing(sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(release / 'shop-before.sqlite')) as destination:
                source.backup(destination)
        check_database(release / 'shop-before.sqlite')
        mutated = True
        for name in baseline:
            atomic_copy(overlay / name, APP / name)
        run(['chroot', '--userspec=33:33', str(ROOT), 'php', str('/var/www/html/bin/commerce-maintenance.php'), '--migrate'])
        check_database(db)
        (release / 'source-hashes.json').write_text(json.dumps({name: digest(APP / name) for name in baseline}, indent=2) + '\n')
        # Even a failed start can briefly serve requests before Supervisor detects failure.
        accepting_writes = True
        run(SUPERVISOR + ['start', 'acg-faka'])
        stopped.remove('acg-faka')
        worker = Path('/personal/pxed/cardgw-commerce-maintenance.sh')
        worker_conf = Path('/personal/pxed/supervisor-commerce-maintenance.conf')
        supervisor_conf = Path('/personal/pxed/supervisord.conf')
        for path in [worker, worker_conf, supervisor_conf]:
            if path.exists():
                shutil.copy2(path, release / path.name)
        atomic_copy(package / 'run-maintenance.sh', worker, owner=(0, 0))
        atomic_copy(package / 'supervisor-commerce-maintenance.conf', worker_conf, owner=(0, 0))
        contents = supervisor_conf.read_text()
        if str(worker_conf) not in contents.split():
            lines = contents.splitlines(keepends=True)
            matches = [i for i, line in enumerate(lines) if line.startswith('files = ')]
            if len(matches) != 1:
                raise RuntimeError('Cannot identify supervisor include list')
            index = matches[0]
            lines[index] = lines[index].rstrip('\n') + ' ' + str(worker_conf) + '\n'
            candidate = release / 'supervisord.updated.conf'
            candidate.write_text(''.join(lines))
            atomic_copy(candidate, supervisor_conf)
        run(SUPERVISOR + ['reread'])
        run(SUPERVISOR + ['update', 'commerce-maintenance'])
        ensure_running('commerce-maintenance')
        if 'commerce-maintenance' in stopped:
            stopped.remove('commerce-maintenance')
        print('PASS source release and additive schema; database never restored', flush=True)
    except BaseException:
        if mutated and not accepting_writes:
            for name, expected in baseline.items():
                if expected is None:
                    (APP / name).unlink(missing_ok=True)
                else:
                    atomic_copy(original / name, APP / name)
            print('Restored pre-release source; retained current database and additive schema', flush=True)
        raise
    finally:
        failures = restore_services(stopped)
        if failures:
            message = 'Services require recovery: ' + ', '.join(failures)
            if sys.exc_info()[0] is None:
                raise RuntimeError(message)
            print(message, file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
