import importlib.util
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mysql_reopen_logs', Path(__file__).with_name('mysql_reopen_logs.py'))
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)


class ReopenTests(unittest.TestCase):
    def test_reopen_pins_target_and_rejects_wrong_or_unready_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pidfile = root / 'mysql.pid'
            pidfile.write_text('123')
            process = root / '123'
            process.mkdir()
            (process / 'comm').write_text('mysqld\n')
            (process / 'cmdline').write_bytes(b'mysqld\0--datadir=/download-db\0')
            (process / 'status').write_text(f'SigBlk:\t{1 << (signal.SIGUSR1 - 1):x}\n')
            with patch.object(logs.os, 'pidfd_open', return_value=42, create=True), \
                 patch.object(logs.os, 'close') as close, \
                 patch.object(logs.signal, 'pidfd_send_signal', create=True) as send:
                logs.reopen(pidfile, '/download-db', root)
                send.assert_called_once_with(42, signal.SIGUSR1)
                close.assert_called_once_with(42)
                for changed_file, changed_value in [('comm', 'another-service'), ('status', 'SigBlk:\t0\n')]:
                    before = (process / changed_file).read_text()
                    (process / changed_file).write_text(changed_value)
                    send.reset_mock()
                    with self.assertRaises(ValueError):
                        logs.reopen(pidfile, '/download-db', root)
                    send.assert_not_called()
                    (process / changed_file).write_text(before)
                send.reset_mock()
                with self.assertRaises(ValueError):
                    logs.reopen(pidfile, '/unrelated-db', root)
                send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
