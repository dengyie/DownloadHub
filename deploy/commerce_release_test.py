"""A source drift or unsafe destination must stop a release before any overwrite."""
import hashlib
import json
import os
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('commerce_release', Path(__file__).resolve().parents[1] / 'commerce/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class SourceGateTest(unittest.TestCase):
    def test_checked_in_overlay_matches_the_release_inventory(self):
        commerce = Path(__file__).resolve().parents[1] / 'commerce'
        baseline = json.loads((commerce / 'release-baseline.json').read_text())
        overlay = commerce / 'overlay'
        files = {str(path.relative_to(overlay)) for path in overlay.rglob('*') if path.is_file()}
        self.assertEqual(files, set(baseline), 'Every source must have an explicit drift precondition')

    def test_drift_and_unexpected_new_file_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app, overlay = root / 'app', root / 'overlay'
            app.mkdir(); overlay.mkdir()
            (app / 'existing.php').write_text('reviewed')
            (overlay / 'existing.php').write_text('replacement')
            (overlay / 'new.php').write_text('new')
            baseline = {'existing.php': hashlib.sha256(b'reviewed').hexdigest(), 'new.php': None}
            release.check_sources(overlay, baseline, app)
            (app / 'existing.php').write_text('external change')
            with self.assertRaisesRegex(RuntimeError, 'Production source changed'):
                release.check_sources(overlay, baseline, app)
            self.assertEqual((app / 'existing.php').read_text(), 'external change')
            (app / 'existing.php').write_text('reviewed')
            (app / 'new.php').write_text('outside scope')
            with self.assertRaisesRegex(RuntimeError, 'New source already exists'):
                release.check_sources(overlay, baseline, app)
            self.assertEqual((app / 'new.php').read_text(), 'outside scope')

    def test_parent_symlink_cannot_escape_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app, overlay, outside = root / 'app', root / 'overlay', root / 'outside'
            for directory in [app, overlay / 'kernel', outside]: directory.mkdir(parents=True)
            (app / 'kernel').symlink_to(outside, target_is_directory=True)
            (overlay / 'kernel/new.php').write_text('new')
            with self.assertRaisesRegex(RuntimeError, 'Unsafe source path'):
                release.check_sources(overlay, {'kernel/new.php': None}, app)
            self.assertFalse((outside / 'new.php').exists())


class PublishPermissionsTest(unittest.TestCase):
    def test_new_app_directories_remain_traversable_under_private_release_umask(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.php'
            source.write_text('fixture')
            target = root / 'app' / 'bin' / 'worker.php'
            old = os.umask(0o077)
            try:
                with patch.object(release.os, 'chown'):
                    release.atomic_copy(source, target)
            finally:
                os.umask(old)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o755)
            self.assertEqual(target.read_text(), 'fixture')


class ServiceRecoveryTest(unittest.TestCase):
    def test_recovery_continues_after_one_service_fails(self):
        with patch.object(release, 'ensure_running', side_effect=[RuntimeError('failed'), None]) as start:
            self.assertEqual(release.restore_services(['commerce-maintenance', 'download-backup']), ['commerce-maintenance'])
        self.assertEqual([call.args[0] for call in start.call_args_list], ['commerce-maintenance', 'download-backup'])

    def test_supervisor_update_already_started_worker_is_not_started_twice(self):
        with patch.object(release, 'is_running', return_value=True), patch.object(release, 'run') as run:
            release.ensure_running('commerce-maintenance')
            run.assert_not_called()


class BackupInventoryTest(unittest.TestCase):
    def test_worker_and_release_evidence_are_preserved_without_losing_prior_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'backup.json'
            evidence = root / 'release'
            evidence.mkdir()
            worker = root / 'worker.sh'
            worker.write_text('fixture')
            original = {'files': ['/existing'], 'sqlite': {'shop': '/db/shop.sqlite'}, 'interval_seconds': 21600}
            config.write_text(json.dumps(original))
            with patch.object(release.os, 'chown'):
                for _ in range(2):
                    release.register_backup_files(config, [worker, evidence], evidence)
            actual = json.loads(config.read_text())
            self.assertEqual(actual['files'], ['/existing', str(worker), str(evidence)])
            self.assertEqual(actual['sqlite'], original['sqlite'])
            self.assertEqual(actual['interval_seconds'], 21600)
            self.assertEqual(json.loads((evidence / 'download-backup.before.json').read_text()), original)


if __name__ == '__main__':
    unittest.main()
