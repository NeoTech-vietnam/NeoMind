#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LIVE_GUARD_DATA=$(/usr/bin/python3 -B "$HERE/runtime_paths.py")
export LIVE_GUARD_DATA
export PYTHONDONTWRITEBYTECODE=1
export TMPDIR="$LIVE_GUARD_DATA/tmp"
mkdir -p "$TMPDIR"
exec unshare -Urn /bin/sh -c '/usr/sbin/ip link set lo up; export FIXTURE_NETNS=1; exec "$1" "$2/fake_acceptance.py"' sh /usr/bin/python3 "$HERE"
