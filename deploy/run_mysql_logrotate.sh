#!/bin/sh
# Extracted distro binary is scoped to cardgw; no system package or cron changes.
set -u
export LD_LIBRARY_PATH=/root/cardgw/tools/usr/lib/x86_64-linux-gnu
while :; do
    if ! /root/cardgw/tools/usr/sbin/logrotate --state /data/cardgw-logrotate.status /personal/pxed/cardgw-mysql-logrotate.conf; then
        echo 'download MySQL log rotation failed' >&2
    fi
    sleep 60
done
