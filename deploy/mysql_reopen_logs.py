#!/usr/bin/env python3
"""Reopen pxed download MySQL logs without SQL credentials or server restart.

MySQL 8.0.46 sql/mysqld.cc handles SIGUSR1 by flushing error/general/slow logs.
Linux pidfds pin the validated process and prevent signaling a reused PID.
"""
import argparse
import os
from pathlib import Path
import signal
import sys


def reopen(pid_file, datadir, proc=Path('/proc')):
    pid = int(Path(pid_file).read_text().strip())
    if pid <= 1:
        raise ValueError('invalid PID')
    descriptor = os.pidfd_open(pid)
    try:
        process = proc / str(pid)
        if (process / 'comm').read_text().strip() != 'mysqld':
            raise ValueError('PID is not mysqld')
        args = (process / 'cmdline').read_bytes().split(b'\0')
        if ('--datadir=' + datadir).encode() not in args:
            raise ValueError('MySQL datadir mismatch')
        status = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines())
        # This MySQL version blocks SIGUSR1 and receives it in its sigwait thread.
        if not int(status['SigBlk'].strip(), 16) & (1 << (signal.SIGUSR1 - 1)):
            raise ValueError('MySQL log signal handler not ready')
        signal.pidfd_send_signal(descriptor, signal.SIGUSR1)
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid-file', required=True)
    parser.add_argument('--datadir', required=True)
    args = parser.parse_args()
    try:
        reopen(args.pid_file, args.datadir)
    except Exception as exc:
        print('MySQL log reopen failed:', type(exc).__name__, file=sys.stderr)
        raise SystemExit(1) from None
