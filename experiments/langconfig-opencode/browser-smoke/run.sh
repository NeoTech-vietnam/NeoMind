#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STAGE=${LANGCONFIG_STAGE:-/dev/shm/neomind-langconfig-approved-20261115-01}
MODULES=${LANGCONFIG_MODULES:-/home/hieu-tran/.local/share/langconfig-eval-20261114/langconfig/node_modules}
CHROME=${CHROME:-/usr/bin/google-chrome}
WORK=$(mktemp -d "${SMOKE_TMP_ROOT:-/tmp/opencode}/langconfig-browser-smoke-XXXXXXXX")
printf 'Isolated browser HOME (kept): %s\n' "$WORK"
exec unshare -Urn env -i PATH=/usr/bin:/bin HOME="$WORK" TMPDIR="$WORK" \
  LANGCONFIG_STAGE="$STAGE" LANGCONFIG_MODULES="$MODULES" CHROME="$CHROME" \
  sh -eu -c 'ip link set lo up; ip -brief address; exec node "$1/smoke.mjs"' sh "$HERE"
