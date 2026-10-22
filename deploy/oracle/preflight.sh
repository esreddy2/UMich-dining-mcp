#!/usr/bin/env bash
# Read-only checks; safe to run on the Oracle VM before copying or building.
set -u
export LC_ALL=C
DOMAIN='umich-dining-mcp.duckdns.org'
echo '=== UMICH DINING ORACLE READ-ONLY PREFLIGHT ==='
[[ $(hostname -s) == dcc ]] || { echo 'ABORT: expected Oracle dcc'; exit 1; }
for x in nginx curl python3 openssl systemctl; do command -v "$x" || echo "MISSING $x"; done
nginx -t 2>&1 || true
printf '\nCertificate:\n'
openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -subject -dates 2>/dev/null || true
printf '\nDNS:\n'
getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '!seen[$1]++ { print "A", $1 }' || true
getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '!seen[$1]++ { print "AAAA", $1 }' || true
printf '\nFRP / Minecraft:\n'
systemctl is-active frps 2>/dev/null || true
ss -lntp | grep -E ':30065[[:space:]]|:7000[[:space:]]|:443[[:space:]]|:8080[[:space:]]' || true
printf '\nExisting runtime:\n'
command -v node 2>/dev/null && node -v || true
command -v npm 2>/dev/null && npm -v || true
command -v podman 2>/dev/null && podman --version || true
printf '\nStorage:\n'
df -hT / /opt 2>/dev/null || true
printf '\n*** CRITICAL: university site from Oracle ***\n'
tmp="$(mktemp)"
status="$(curl -sS -L --max-time 25 -A 'python-requests/2.32.3' -o "$tmp" -w '%{http_code}' 'https://dining.umich.edu/menus-locations/dining-halls/bursley/' 2>/dev/null)" || status='NETWORK_ERROR'
echo "University upstream HTTP=$status"
if [[ "$status" == 200 ]] && ! head -c 8192 "$tmp" | grep -Eiq 'cf-browser-verification|cf_chl_opt|challenge-platform|just a moment|attention required'; then
  echo 'UPSTREAM_GO_NO_GO=PASS'
else
  echo 'UPSTREAM_GO_NO_GO=FAIL: do not deploy public MCP here unless approved/allowlisted'
fi
rm -f -- "$tmp"
echo '=== PREFLIGHT COMPLETE: NO CHANGES MADE ==='
