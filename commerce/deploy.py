#!/usr/bin/env python3
"""pxed storefront cutover; source hash checks precede all production mutation."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

ROOT = Path('/srv/acg-rootfs')
APP = ROOT / 'var/www/html'
SUPERVISOR = ['supervisorctl', '-c', '/personal/pxed/supervisord.conf']

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check_sources(overlay, baseline):
    for name, expected in baseline.items():
        path = APP / name
        if expected is None:
            if path.exists():
                raise RuntimeError('New overlay file already exists: ' + name)
        elif not path.is_file() or sha(path) != expected:
            raise RuntimeError('Production source changed since review: ' + name)
        if not (overlay / name).is_file():
            raise RuntimeError('Overlay file missing: ' + name)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release-dir', required=True)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    package = Path(__file__).resolve().parent
    release = Path(args.release_dir)
    baseline = json.loads((package / 'source-baseline.json').read_text())
    overlay = package / 'overlay'
    check_sources(overlay, baseline)
    for path in overlay.rglob('*.php'):
        inside = '/' + str(path.relative_to(ROOT))
        run(['chroot', str(ROOT), 'php', '-l', inside], stdout=subprocess.DEVNULL)
    if (ROOT / 'var/lib/acg-faka/shop.sqlite').exists():
        raise RuntimeError('Commerce SQLite already exists; refusing a second cutover')
    if args.preflight_only:
        print('PASS source hashes, PHP lint, destination absent', flush=True)
        return
    release.mkdir(mode=0o700)
    original = release / 'original'
    original.mkdir()
    for name in baseline:
        src = APP / name
        if src.exists():
            dst = original / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    shutil.copy2(APP / 'config/database.php', release / 'database.php')
    shutil.copy2('/personal/pxed/download-backup.json', release / 'download-backup.json')
    stopped = False
    applied = False
    accepting_writes = False
    try:
        run(SUPERVISOR + ['stop', 'download-backup'])
        run(SUPERVISOR + ['stop', 'acg-faka'])
        stopped = True
        check_sources(overlay, baseline)
        print('Storefront stopped; taking final MySQL + application backup', flush=True)
        run(['python3', '/personal/pxed/cardgw-backup-snapshot.py', '--config', '/personal/pxed/download-backup.json', '--once'])
        export = ROOT / 'var/lib/acg-faka/mysql-export-20261002'
        export.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        run(['chroot', str(ROOT), 'php', '/' + str((package / 'migrate.php').relative_to(ROOT)),
             '--defaults-file=/tmp/cardgw-migrate.cnf', '--output-dir=/' + str(export.relative_to(ROOT)), '--quiesced'])
        manifest = json.loads((export / 'manifest.json').read_text())
        if not manifest['quiesced'] or len(manifest['databases']) != 13 or sum(len(d['tables']) for d in manifest['databases']) != 140:
            raise RuntimeError('Final inventory changed; inspect before deploying')
        shutil.copy2(export / 'manifest.json', release / 'migration-manifest.json')
        database = export.parent / 'shop.sqlite'
        # Source export is closed and reconciled; retain it unchanged as cutover evidence.
        shutil.copy2(export / 'acg_faka.sqlite', database)
        with closing(sqlite3.connect(database)) as db:
            if db.execute('PRAGMA journal_mode=WAL').fetchone()[0] != 'wal':
                raise RuntimeError('Cannot enable WAL')
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise RuntimeError('Final database integrity failed')
        os.chown(export.parent, 33, 33)
        os.chmod(export.parent, 0o750)
        os.chown(database, 33, 33)
        os.chmod(database, 0o600)
        applied = True
        for name in baseline:
            target = APP / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(overlay / name, target)
            os.chmod(target, 0o644)
        config = "<?php\nreturn ['driver'=>'sqlite','database'=>'/var/lib/acg-faka/shop.sqlite','prefix'=>'acg_','busy_timeout'=>5000];\n"
        (APP / 'config/database.php').write_text(config)
        os.chown(APP / 'config/database.php', 33, 33)
        os.chmod(APP / 'config/database.php', 0o600)
        backup = json.loads((release / 'download-backup.json').read_text())
        backup.pop('mysql', None)
        backup['sqlite']['commerce.sqlite'] = str(database)
        backup['files'].append(str(export))
        Path('/personal/pxed/download-backup.json').write_text(json.dumps(backup, indent=2) + '\n')
        # A complete SQLite backup must succeed before opening the storefront.
        run(['python3', '/personal/pxed/cardgw-backup-snapshot.py', '--config', '/personal/pxed/download-backup.json', '--once'])
        (release / 'accepting-sqlite-writes').write_text(str(time.time()))
        accepting_writes = True
        run(SUPERVISOR + ['start', 'acg-faka'])
        run(SUPERVISOR + ['start', 'download-backup'])
        (release / 'source-hashes.json').write_text(json.dumps({name: sha(APP/name) for name in baseline}, indent=2))
        print('CUTOVER COMPLETE; SQLite accepts writes. Do not restore the old MySQL snapshot.', flush=True)
    except BaseException:
        if not accepting_writes:
            if applied:
                for name, expected in baseline.items():
                    target = APP / name
                    if expected is None:
                        target.unlink(missing_ok=True)
                    else:
                        shutil.copy2(original / name, target)
                shutil.copy2(release / 'database.php', APP / 'config/database.php')
                shutil.copy2(release / 'download-backup.json', '/personal/pxed/download-backup.json')
            if stopped:
                run(SUPERVISOR + ['start', 'acg-faka'])
            run(SUPERVISOR + ['start', 'download-backup'])
        else:
            print('Post-cutover failure: preserve SQLite writes; no automatic stale rollback.', flush=True)
        raise

if __name__ == '__main__':
    main()
