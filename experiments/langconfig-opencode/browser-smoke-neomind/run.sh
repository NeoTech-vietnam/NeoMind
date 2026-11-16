#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODULES=${LANGCONFIG_MODULES:-/home/hieu-tran/.local/share/langconfig-eval-20261114/langconfig/node_modules}
CHROME=${CHROME:-/usr/bin/google-chrome}
WORK=$(mktemp -d "${SMOKE_TMP_ROOT:-/dev/shm}/neomind-preview-smoke-XXXXXXXX")
printf 'Fixture and isolated HOME (kept): %s\n' "$WORK"
exec unshare -Urn env -i PATH=/usr/bin:/bin HOME="$WORK" TMPDIR="$WORK" XDG_STATE_HOME="$WORK/state" \
  LANGCONFIG_MODULES="$MODULES" CHROME="$CHROME" WORK="$WORK" \
  GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \
  sh -eu -c 'ip link set lo up; ip -brief address; exec node "$1/smoke.mjs"' sh "$HERE"
