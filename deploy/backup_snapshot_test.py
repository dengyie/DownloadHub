import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_snapshot', Path(__file__).with_name('backup_snapshot.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class SnapshotTests(unittest.TestCase):
    def test_wal_rows_are_restorable_and_only_completed_snapshots_are_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = sqlite3.connect(root / 'live.db')
            try:
                db.execute('pragma journal_mode=wal')
                db.execute('create table sample(value text)')
                db.execute("insert into sample values('committed in WAL')")
                db.commit()
                config = {'destination': str(root / 'backups'), 'sqlite': {'cards.db': str(root / 'live.db')}, 'retain': 1}
                first = backup.snapshot(config)
                second = backup.snapshot(config)
                self.assertFalse(first.exists())
                with closing(sqlite3.connect(second / 'cards.db')) as restored:
                    self.assertEqual(restored.execute('select value from sample').fetchone()[0], 'committed in WAL')
                self.assertIn('cards.db', json.loads((second / 'manifest.json').read_text()))
            finally:
                db.close()

    def test_failed_dump_keeps_previous_snapshot_and_publishes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {'destination': str(root), 'sqlite': {}}
            previous = backup.snapshot(config)
            config['mysql'] = {'executable': '/usr/bin/false', 'defaults_file': '/not-used', 'databases': ['sample']}
            with self.assertRaises(Exception):
                backup.snapshot(config)
            self.assertTrue(previous.exists())
            self.assertEqual(list(root.glob('.partial-*')), [])
            self.assertEqual(len(list(root.glob('snapshot-*'))), 1)


if __name__ == '__main__':
    unittest.main()
