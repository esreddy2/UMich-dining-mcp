#!/usr/bin/env bash
# Run once on Oracle Linux 9 as root, AFTER the read-only upstream go/no-go probe.
# Usage: sudo bash deploy/oracle/install.sh /home/opc/umich-dining-mcp-0.2.0.zip
set -Eeuo pipefail

DOMAIN='umich-dining-mcp.duckdns.org'
BASE='/opt/umich-dining-mcp'
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
SERVICE='umich-dining-mcp.service'
CONFIG='/etc/nginx/conf.d/umich-dining-mcp.conf'
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
NODE_VERSION='22.23.3'
NODE_BASE="$BASE/node-v$NODE_VERSION"
NODE_LINK="$BASE/node"
ARCHIVE="${1:-}"
BACKUP=''
OLD_CURRENT=''
STAGE=''

abort() { echo "ABORT: $*" >&2; exit 1; }
section() { printf '\n========== %s ==========\n' "$1"; }

[[ $(hostname -s) == 'dcc' ]] || abort 'Wrong machine: expected Oracle dcc'
[[ $EUID -eq 0 ]] || abort 'Must run as root'
[[ -n $ARCHIVE && -f $ARCHIVE ]] || abort 'Supply the locally uploaded source ZIP path'
[[ -f $CERT && -f $KEY ]] || abort 'Existing new-domain SSL certificate missing'
systemctl is-active --quiet frps || abort 'FRP offline; do not modify hosting'
ss -H -lnt | grep -Eq ':30065[[:space:]]' || abort 'Minecraft listener missing'
nginx -t || abort 'NGINX not valid'
[[ ! -L $CONFIG ]] || abort 'NGINX project config is an unexpected symlink'
[[ ! -L $RELEASES ]] || abort 'Unexpected release symlink'

section '1. Upstream access go/no-go'
TMP_UPSTREAM="$(mktemp)"
trap 'rm -f -- "$TMP_UPSTREAM"' EXIT
STATUS="$(curl --max-time 25 -sS -A 'python-requests/2.32.3' -o "$TMP_UPSTREAM" -w '%{http_code}' 'https://dining.umich.edu/menus-locations/dining-halls/bursley/')" \
  || abort 'University menu site unavailable from Oracle'
[[ $STATUS == '200' ]] || abort "University upstream status: $STATUS (do not bypass blocks)"
if head -c 8192 "$TMP_UPSTREAM" | grep -Eiq 'cf-browser-verification|cf_chl_opt|challenge-platform|just a moment|attention required'; then
  abort 'Upstream challenge detected; do not deploy this IP'
fi
rm -f -- "$TMP_UPSTREAM"
trap - EXIT
printf '%s\n' 'UPSTREAM_HTTP=200'

section '2. Install minimal prerequisites'
for tool in python3 curl openssl nginx systemctl runuser sha256sum; do command -v "$tool" >/dev/null || abort "Missing: $tool"; done
mkdir -p "$RELEASES"

section '3. Install verified private Node 22 (no changes to system Node)'
if [[ ! -x $NODE_BASE/bin/node ]]; then
  case "$(uname -m)" in
    aarch64) NODE_ARCH='arm64';;
    x86_64) NODE_ARCH='x64';;
    *) abort 'Unsupported architecture';;
  esac
  TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  NODE_TMP="$(mktemp -d)"
  trap 'rm -rf -- "$NODE_TMP"' EXIT
  curl -fsS --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$NODE_TMP/$TARBALL"
  curl -fsS --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
  (cd "$NODE_TMP" && grep -E "^[a-f0-9]{64}  $TARBALL\$" SHASUMS256.txt | sha256sum -c -) \
    || abort 'Node download checksum did not match'
  mkdir -p "$NODE_BASE"
  tar -xJf "$NODE_TMP/$TARBALL" -C "$NODE_BASE" --strip-components=1
  rm -rf -- "$NODE_TMP"
  trap - EXIT
fi
ln -sfn "node-v$NODE_VERSION" "$NODE_LINK"
NODE="$NODE_LINK/bin/node"
NPM="$NODE_LINK/bin/npm"
"$NODE" --version
[[ -x $NPM ]] || abort 'Verified Node archive has no npm'

section '4. Create restricted service user'
if ! getent passwd umichmcp >/dev/null; then
  useradd --system --user-group --create-home --home-dir /var/lib/umichmcp --shell /sbin/nologin umichmcp
fi

section '5. Extract provided ZIP safely'
STAGE="$(mktemp -d "$RELEASES/.staging.XXXXXXXX")"
python3 - "$ARCHIVE" "$STAGE" <<'PY'
from pathlib import Path
import zipfile,sys
src=Path(sys.argv[1]); dst=Path(sys.argv[2]).resolve()
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        p=Path(info.filename)
        if p.is_absolute() or '..' in p.parts or ((info.external_attr >> 16) & 0o170000) == 0o120000:
            raise SystemExit(f'UNSAFE ARCHIVE ENTRY: {info.filename}')
    z.extractall(dst)
roots=[p for p in dst.iterdir() if p.is_dir()]
if len(roots)!=1 or not (roots[0]/'package.json').is_file():
    raise SystemExit('Expected one source directory in ZIP')
import shutil
for p in list(roots[0].iterdir()): shutil.move(str(p),str(dst/p.name))
roots[0].rmdir()
PY
[[ $("$NODE" -p "require('$STAGE/package.json').version") == '0.2.0' ]] || abort 'Expected vetted 0.2.0 source ZIP'
chown -R umichmcp:umichmcp "$STAGE"

section '6. Install locked dependencies, test, and compile'
runuser -u umichmcp -- env PATH="$NODE_LINK/bin:/usr/bin:/bin" HOME=/var/lib/umichmcp \
  sh -c 'cd "$1" && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm run lint && npm test && npm run test:oracle && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund' sh "$STAGE" \
  || abort 'Build/tests failed; production site was not changed'

section '7. Install new release and service unit'
RELEASE="$RELEASES/0.2.0-$(date -u +%Y%m%d%H%M%S)"
[[ ! -e $RELEASE ]] || abort 'Release path already exists'
mv -- "$STAGE" "$RELEASE"
STAGE=''
if [[ -L $CURRENT ]]; then OLD_CURRENT="$(readlink "$CURRENT")"; fi
ln -sfn "releases/$(basename "$RELEASE")" "$CURRENT"
mkdir -p /etc/umich-dining-mcp
if [[ ! -f /etc/umich-dining-mcp/server.env ]]; then
  install -o root -g umichmcp -m 0640 "$CURRENT/deploy/oracle/server.env.example" \
    /etc/umich-dining-mcp/server.env
fi
install -o root -g root -m 0644 "$CURRENT/deploy/oracle/umich-dining-mcp.service" \
  /etc/systemd/system/umich-dining-mcp.service
systemctl daemon-reload
systemctl enable --now "$SERVICE"
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 -H "Host: $DOMAIN" http://127.0.0.1:8080/healthz >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 5 -H "Host: $DOMAIN" http://127.0.0.1:8080/healthz \
  || abort 'Local Node health check failed (nginx untouched)'

section '8. Install isolated HTTPS virtual host'
if [[ -f $CONFIG ]]; then
  BACKUP="$(mktemp /etc/nginx/conf.d/.umich-mcp-backup.XXXXXXXX)"
  cp -p -- "$CONFIG" "$BACKUP"
fi
install -o root -g root -m 0644 "$CURRENT/deploy/oracle/umich-dining-mcp.nginx.conf" "$CONFIG"
if ! nginx -t; then
  if [[ -n $BACKUP ]]; then cp -p "$BACKUP" "$CONFIG"; else rm -f -- "$CONFIG"; fi
  nginx -t || true
  abort 'New NGINX config invalid, previous config restored'
fi
nginx -s reload
sleep 2
curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/healthz" \
  || abort 'HTTPS health check failed; inspect NGINX and app logs'

section '9. Verify FRP, Minecraft, and HTTPS'
systemctl is-active "$SERVICE"
systemctl is-active frps
ss -lnt | grep -E ':30065[[:space:]]' || abort 'Minecraft listener missing'
printf '\nLive HTTPS endpoint: https://%s/mcp\n' "$DOMAIN"
printf 'Health endpoint: https://%s/healthz\n' "$DOMAIN"
echo 'DEPLOYMENT_SUCCESS=YES'
