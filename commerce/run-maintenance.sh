#!/bin/sh
# Application worker only. Each batch releases PHP memory; no host configuration.
set -u
child=
stop() {
    trap - TERM INT
    if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi
    exit 0
}
trap stop TERM INT
while :; do
    /usr/sbin/chroot --userspec=33:33 /srv/acg-rootfs /usr/local/bin/php -d memory_limit=64M /var/www/html/bin/commerce-maintenance.php --once &
    child=$!
    wait "$child" || :
    sleep 60 &
    child=$!
    wait "$child" || :
    child=
done
