#!/usr/bin/env bash
# Publishes a built installer to the VM, which serves it under /releases/ (PLAN fase 10.2):
#   publish-release.sh <dir> <remote-dir> <stable-name>
# <dir> holds the versioned installer, its .sig and latest.json (installer.yml's artifact).
# Order matters: the installer and the stable copy first, latest.json last, each renamed
# into place, so the updater and new users never see a file that is not there or half
# written. Keeps the three newest versioned installers. Needs `ssh vm` (actions/vm-ssh).
set -euo pipefail
dir=$1 remote=$2 stable=$3

installer=$(cd "$dir" && ls -- *_x64-setup.exe)
[ "$(printf '%s\n' "$installer" | wc -l)" = 1 ] || { echo "expected one installer in $dir" >&2; exit 1; }
[ -f "$dir/$installer.sig" ] && [ -f "$dir/latest.json" ] || { echo "missing .sig or latest.json in $dir" >&2; exit 1; }

scp -q "$dir/$installer" "$dir/$installer.sig" vm:"$remote/"
scp -q "$dir/latest.json" vm:"$remote/.latest.json.tmp"
# shellcheck disable=SC2087 # expanded here on purpose
ssh vm bash -s <<EOF
set -euo pipefail
cd '$remote'
cp -- '$installer' .stable.tmp && mv -f -- .stable.tmp '$stable'
mv -f -- .latest.json.tmp latest.json
ls -1t -- *_x64-setup.exe | tail -n +4 | while IFS= read -r old; do rm -f -- "\$old" "\$old.sig"; done
ls -l
EOF
