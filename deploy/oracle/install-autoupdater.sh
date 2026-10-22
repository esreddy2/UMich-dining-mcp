#!/usr/bin/env bash
# Run on Oracle dcc only, AFTER an already healthy manual deployment.
# Usage: sudo bash deploy/oracle/install-autoupdater.sh
set -Eeuo pipefail
[[ $(hostname -s) == dcc && $EUID -eq 0 ]] || { echo 'Wrong machine/user' >&2; exit 1; }
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE=/opt/umich-dining-mcp
[[ -L $BASE/current ]] || { echo 'Missing current deployment' >&2; exit 1; }
[[ -f /etc/umich-dining-mcp/server.env ]] || { echo 'Missing runtime env' >&2; exit 1; }
[[ -x $BASE/node/bin/node ]] || { echo 'Missing private Node' >&2; exit 1; }
systemctl is-active --quiet umich-dining-mcp.service
systemctl is-active --quiet frps.service
curl --noproxy '*' -fsS --max-time 8 -H 'Host: umich-dining-mcp.duckdns.org' http://127.0.0.1:8080/healthz >/dev/null
for f in auto-update.py umich-dining-mcp-update.service umich-dining-mcp-update.timer; do
  [[ -f $HERE/$f && ! -L $HERE/$f ]] || { echo "Missing installer input: $f" >&2; exit 1; }
done
if ! getent passwd umichmcpbuild >/dev/null; then
  useradd --system --user-group --create-home --home-dir /var/lib/umichmcpbuild --shell /sbin/nologin umichmcpbuild
fi
install -o root -g root -m 0755 "$HERE/auto-update.py" /usr/local/sbin/umich-dining-mcp-autoupdate
install -o root -g root -m 0644 "$HERE/umich-dining-mcp-update.service" /etc/systemd/system/umich-dining-mcp-update.service
install -o root -g root -m 0644 "$HERE/umich-dining-mcp-update.timer" /etc/systemd/system/umich-dining-mcp-update.timer
systemctl daemon-reload
systemctl enable --now umich-dining-mcp-update.timer
printf '\nAUTOMATIC_GITHUB_RELEASE_UPDATES=ENABLED\n'
systemctl list-timers --all umich-dining-mcp-update.timer --no-pager
printf '\nREAD_ONLY_CURRENT_RELEASE_CHECK:\n'
/usr/local/sbin/umich-dining-mcp-autoupdate --check
printf '\nMinecraft/FRP remains untouched.\n'
