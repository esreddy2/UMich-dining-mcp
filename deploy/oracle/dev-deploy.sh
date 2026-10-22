#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO="${UMICH_MCP_REPO:-$HOME/projects/personal/UMich-dining-mcp}"
SSH_KEY="$HOME/.ssh/id_ed25519_umich_mcp_deploy"
HOST_KEYS="$HOME/.ssh/known_hosts_umich_oracle"
DEST="umichmcpdeploy@163.192.196.65"

fail() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

[[ "$(id -un)" == 'dev' ]] || fail 'Run as dev on eecs-280'
[[ -d "$REPO/.git" ]] || fail "Git checkout not found: $REPO"
[[ -f "$SSH_KEY" && -f "$HOST_KEYS" ]] || fail 'Dedicated SSH key or pinned host key missing'
for c in git ssh python3; do command -v "$c" >/dev/null || fail "Required program missing: $c"; done

cd "$REPO"
[[ -f package.json && -f package-lock.json ]] || fail 'Missing package manifest/lockfile'

declare -a SSH=(
  ssh -T -F /dev/null -i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$HOST_KEYS"
  -o GlobalKnownHostsFile=/dev/null
  -o HostKeyAlgorithms=ssh-ed25519
  -o UpdateHostKeys=no
  -o ConnectTimeout=12
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=20
  -o ControlMaster=no
)

echo '=== UMICH DINING MCP: DEPLOY DEVELOPMENT SNAPSHOT ==='
echo "Local branch: $(git branch --show-current)"
echo "Local commit: $(git rev-parse --short HEAD)"
echo 'Uncommitted modifications are INCLUDED in the snapshot.'

echo '1. Check restricted Oracle deployment gateway'
"${SSH[@]}" "$DEST" status || fail 'Restricted Oracle SSH gateway unavailable'

ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/umich-mcp-dev.XXXXXXXX.tar.gz")"
trap 'rm -f -- "$ARCHIVE"' EXIT

printf '\n2. Snapshot tracked and untracked non-ignored source files\n'
python3 - "$ARCHIVE" <<'PY'
from pathlib import Path
import json
import os
import stat
import subprocess
import sys
import tarfile

archive = Path(sys.argv[1])
paths = subprocess.check_output(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']
).split(b'\0')
names = sorted({os.fsdecode(raw) for raw in paths if raw})
for required in ['package.json', 'package-lock.json', 'src/http-server.ts']:
    if required not in names:
        raise SystemExit('ABORT: required source file not found: ' + required)

sensitive = {'.git', '.ssh', '.npm', '.npmrc', '.env', 'node_modules'}
limit_expanded = 180 * 1024 * 1024
limit_compressed = 32 * 1024 * 1024
count = total = 0
with tarfile.open(archive, 'w:gz', compresslevel=6, format=tarfile.PAX_FORMAT) as tar:
    for name in names:
        p = Path(name)
        parts = p.parts
        if (p.is_absolute() or '..' in parts or '\\' in name or
            len(name) > 500 or any(ord(c) < 32 for c in name)):
            raise SystemExit('ABORT: unsafe repository path: ' + repr(name))
        if any(part in sensitive or part.startswith('.env.') for part in parts):
            raise SystemExit('ABORT: secret/generated path is tracked or unignored: ' + repr(name))
        if p.is_symlink():
            raise SystemExit('ABORT: symlink not accepted by remote receiver: ' + repr(name))
        if not p.exists():
            # Deliberately deleted tracked files should not be deployed.
            continue
        metadata = p.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit('ABORT: non-file repository entry: ' + repr(name))
        total += metadata.st_size
        count += 1
        if count > 8000 or total > limit_expanded:
            raise SystemExit('ABORT: source snapshot exceeds remote safety limits')
        entry = tarfile.TarInfo(name)
        entry.size = metadata.st_size
        entry.mode = 0o644
        entry.mtime = 0
        entry.uid = entry.gid = 0
        entry.uname = entry.gname = ''
        with p.open('rb') as content:
            tar.addfile(entry, content)
if archive.stat().st_size > limit_compressed:
    raise SystemExit('ABORT: compressed snapshot exceeds 32 MiB')
print(f'SNAPSHOT_FILES={count}')
print(f'SNAPSHOT_EXPANDED_BYTES={total}')
print(f'SNAPSHOT_COMPRESSED_BYTES={archive.stat().st_size}')
print(f'PACKAGE_VERSION={json.loads(Path("package.json").read_text())["version"]}')
PY

printf '\n3. Upload, test, build and activate DEV only (no GitHub push)\n'
"${SSH[@]}" "$DEST" deploy < "$ARCHIVE" || fail 'Remote development deployment failed; check output above'

echo
echo '=== DEVELOPMENT DEPLOY COMMAND FINISHED ==='
echo 'DEV_INTERNAL=http://127.0.0.1:8081/mcp (Oracle loopback)'

# The state of the public dev endpoint is probed, not asserted. The previous
# version of this script printed "not yet enabled" whatever was true, and the
# endpoint was public and unauthenticated the whole time.
DEV_PUBLIC_URL="https://umich-dining-mcp.duckdns.org/dev/mcp"
probe="$(curl -sS -m 20 -o /tmp/umich-mcp-probe.$$ -w '%{http_code}' \
  -X POST "$DEV_PUBLIC_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null || echo '000')"
rm -f -- "/tmp/umich-mcp-probe.$$"

case "$probe" in
  200)
    echo "DEV_PUBLIC=REACHABLE WITHOUT A TOKEN at $DEV_PUBLIC_URL (HTTP $probe)."
    echo 'DEV_PUBLIC=the endpoint is open to the internet. Put a bearer token in place,'
    echo 'DEV_PUBLIC=or take it out of the nginx configuration, before anything else.'
    ;;
  401|403)
    echo "DEV_PUBLIC=reachable at $DEV_PUBLIC_URL but a token is required (HTTP $probe)."
    ;;
  000)
    echo "DEV_PUBLIC=not reachable from here (HTTP $probe); the endpoint may be private."
    ;;
  *)
    echo "DEV_PUBLIC=answered HTTP $probe at $DEV_PUBLIC_URL; the state of the endpoint is unclear."
    ;;
esac

echo 'PRODUCTION=not touched by this deploy command'
