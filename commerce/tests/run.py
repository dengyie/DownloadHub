#!/usr/bin/env python3
"""Run the real PHP services against pinned public code and disposable SQLite DBs."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_for(baseline):
    cache = Path(os.environ.get("COMMERCE_TEST_CACHE", Path(tempfile.gettempdir()) / "cardgw-commerce-cache"))
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / (baseline["archive_sha256"] + ".tar.gz")
    if archive.is_file() and digest(archive) == baseline["archive_sha256"]:
        return archive
    # The download is published only after its complete contents pass verification.
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as output:
        download = Path(output.name)
        try:
            with urllib.request.urlopen(baseline["archive_url"], timeout=60) as response:
                shutil.copyfileobj(response, output)
            output.flush()
            if digest(download) != baseline["archive_sha256"]:
                raise RuntimeError("Public application archive SHA-256 mismatch")
            os.replace(download, archive)
        finally:
            download.unlink(missing_ok=True)
    return archive


def prepare(app, baseline):
    app.mkdir(mode=0o700)
    prefix = "acg-faka-" + baseline["commit"]
    with tarfile.open(archive_for(baseline)) as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != prefix:
                raise RuntimeError("Unsafe path in application archive")
            relative = PurePosixPath(*path.parts[1:])
            if not relative.parts:
                continue
            # Do not copy any installation/configuration data, assets or entry points.
            selected = (relative.parts[0] == "vendor"
                        or (relative.parts[0] in {"app", "kernel"} and relative.suffix == ".php")
                        or str(relative) in {"composer.json", "composer.lock", "LICENSE"})
            if not selected or member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError("Application fixture must not contain links or devices")
            target = app / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
    for filename, key in [("composer.json", "composer_json_sha256"), ("composer.lock", "composer_lock_sha256")]:
        if digest(app / filename) != baseline[key]:
            raise RuntimeError(filename + " differs from the reviewed runtime")
    if (app / "composer.lock").read_bytes() != (FIXTURES / "composer.lock").read_bytes():
        raise RuntimeError("Tracked dependency lock does not match the pinned application")
    locked = json.loads((app / "composer.lock").read_text())["packages"]
    installed = json.loads((app / "vendor/composer/installed.json").read_text())["packages"]
    # The upstream release includes its vendor tree. Verify its exact versions and
    # source/dist references against the lock, without Composer updates or scripts.
    identify = lambda packages: {p["name"]: (p["version"], p.get("source"), p.get("dist")) for p in packages}
    if identify(locked) != identify(installed):
        raise RuntimeError("Bundled dependencies differ from composer.lock")
    schema_sql = FIXTURES / "schema.sql"
    if digest(schema_sql) != baseline["schema_sha256"]:
        raise RuntimeError("Schema fixture SHA-256 mismatch")
    schema = app.parent / "schema.sqlite"
    with closing(sqlite3.connect(schema)) as db, db:
        db.executescript(schema_sql.read_text())
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        if len(tables) != baseline["schema_tables"]:
            raise RuntimeError("Incomplete schema fixture")
        for (name,) in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            if db.execute("SELECT count(*) FROM " + quoted).fetchone()[0] != 0:
                raise RuntimeError("Schema fixture must not contain data")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Invalid schema fixture")
    (app / ".commerce-test-fixture").write_text(baseline["commit"] + "\n")
    return schema


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--php", default=os.environ.get("PHP", "php"), help="PHP 8.2 executable")
    args = parser.parse_args()
    if not shutil.which(args.php):
        parser.error("PHP 8.2 is required; CI installs it with all required extensions")
    subprocess.run([args.php, "-r", "foreach (['bcmath','pdo_sqlite','sqlite3','mbstring','curl','gd','zip','openssl'] as $ext) { if (!extension_loaded($ext)) { fwrite(STDERR, \"Missing PHP extension: $ext\\n\"); exit(1); } } echo 'PHP '.PHP_VERSION.' / SQLite '.SQLite3::version()['versionString'].PHP_EOL;"], check=True)
    for source in sorted(HERE.parent.rglob("*.php")):
        lint = subprocess.run([args.php, "-l", str(source)], capture_output=True, text=True)
        if lint.returncode:
            raise RuntimeError(lint.stdout + lint.stderr)
    print("PASS commerce PHP syntax", flush=True)
    baseline = json.loads((FIXTURES / "baseline.json").read_text())
    with tempfile.TemporaryDirectory(prefix="commerce-suite-") as temporary:
        app = Path(temporary) / "app"
        schema = prepare(app, baseline)
        environment = dict(os.environ, COMMERCE_TEST_APP=str(app), COMMERCE_SCHEMA_DB=str(schema))
        for suite in ["sqlite", "bill", "migration", "orders", "card-deletion", "storefront"]:
            command = [args.php, "-d", "error_reporting=24575", str(HERE / (suite + ".php"))]
            if suite == "migration":
                command.append(str(schema))
            print("Running commerce " + suite, flush=True)
            subprocess.run(command, env=environment, check=True, timeout=120)
    print("PASS all six commerce suites (isolated public fixture)", flush=True)


if __name__ == "__main__":
    main()
