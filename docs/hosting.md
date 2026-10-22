# Oracle deployment: UMich Dining MCP (unofficial)

The source is public, the data comes from the University of Michigan dining site,
and this project is not affiliated with or endorsed by the university.
Do not bypass HTTP 403 / Cloudflare challenges or increase upstream concurrency.

## Architecture and protection of existing services

- Domain: `umich-dining-mcp.duckdns.org`, IPv4 `163.192.196.65`, IPv6
  `2603:c028:4508:b500:0:2ab0:10cc:92cc`.
- TLS: Existing Let's Encrypt certificate at
  `/etc/letsencrypt/live/umich-dining-mcp.duckdns.org/`; webroot renewal
  still uses NGINX port 80.
- NGINX (already installed) accepts 443 and proxies **only** `/mcp` and
  `/healthz` to a native Node 22 service on `127.0.0.1:8080`.
- `frps.service`, Minecraft port 30065, the `maplessmp.duckdns.org` DNS
  updater/certificate, and Grafana/Tailscale remain unchanged.
- The HTTP process runs as `umichmcp`, with no shell login, writable
  system paths, or administrator privileges. Systemd limits it to 384 MiB
  and one CPU core. One process means one cache and upstream limiter.
- The host's time zone does not change any answer: every published day and
  every mealtime is read in the campus zone, `America/Detroit` (EST/EDT), so a
  host in Chicago and a host in UTC behave identically. See the README
  section on time.
- Public usage is anonymous by default (all tools are read-only) with IP
  and global admission control; optional hashed bearer token config exists.

## Preflight: critical upstream go/no-go

On Oracle `dcc`, before installing anything, check with **one read-only command**:

```bash
sudo bash deploy/oracle/preflight.sh
```

The installer repeats the same test and **stops** if
`https://dining.umich.edu/menus-locations/dining-halls/bursley/` returns 403, a network error, or a
recognized Cloudflare challenge. A 200 is necessary but not sufficient to
prove that live menu requests work; test the real tools afterward. Do not
attempt to defeat blocking; request an allowlist or retain the npm stdio mode.

## Install after verified source/tests

Upload the versioned source ZIP (`umich-dining-mcp-0.2.0.zip`) to the Oracle
VM (for example `/home/opc/umich-dining-mcp-0.2.0.zip`). Copy the
**installer included in the ZIP** into a temporary directory with Python
zipfile, then use one action command from an SSH shell on Oracle:

```bash
sudo bash -euo pipefail <<'SH'
ZIP=/home/opc/umich-dining-mcp-0.2.0.zip
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
python3 -m zipfile -e "$ZIP" "$TMP"
bash "$TMP/UMich-dining-mcp-feat-rebuild/deploy/oracle/install.sh" "$ZIP"
SH
```

The installer verifies Node's download checksum, installs only a private
Node 22 runtime under `/opt/umich-dining-mcp`, unpacks a versioned
release, runs `npm ci`, typecheck, lint, offline tests, independent oracle
fixtures, builds, enables a restricted systemd unit, installs its own
NGINX 443 config, and checks HTTPS health. It does **not** change the
old Minecraft domain, FRP, existing port 80 server, or Certbot cron.

Oracle's **VCN Security List/NSG** is separate from the VM firewall. Verify
public inbound TCP 443 is allowed for IPv4 and IPv6 and points to the
correct VM; this requires console/cloud permissions. Do not open TCP 8080.
IPv6 `AAAA` alone does not guarantee public IPv6 connectivity.

## Testing

```bash
curl -fsS https://umich-dining-mcp.duckdns.org/healthz
curl -fsS -X POST https://umich-dining-mcp.duckdns.org/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For true end-to-end verification use `Client` with
`StreamableHTTPClientTransport` from `@modelcontextprotocol/client` and
call `listTools` and one real tool. A healthy `/healthz` intentionally
**does not fetch the dining site**. If upstream responds with 403/challenge
later, the server returns a controlled error or previously cached data.

## Automatic update from tagged GitHub releases (maintainer only)

The Oracle server does **not** automatically update just because code is pushed
to GitHub. The maintainer can opt into a **pull-based** systemd timer. It checks
GitHub about twice per hour for the highest stable `vX.Y.Z` tag and waits for
that exact version to also be published as `umich-dining-mcp@latest` on npm.
This prevents an unreviewed branch commit or an incomplete tag/publish cycle
from triggering a deployment. No GitHub deploy credentials are needed because
the repository and npm package are public.

After a verified initial native Oracle deployment, install the timer **once**
from a trusted reviewed checkout of the release source:

```bash
sudo bash deploy/oracle/install-autoupdater.sh
```

This installs a root-owned updater script, a dedicated unprivileged build user,
and `umich-dining-mcp-update.service`/`.timer`. Release source is downloaded
from GitHub by exact tag commit SHA, checked against the published npm version
and committed `package-lock.json`, then built with `npm ci --ignore-scripts` and
validated with typechecking, lint, offline tests, independent oracle tests and
a production build. Nothing is activated unless these checks pass.

The old `current` release stays intact during preparation. Activation swaps
`current`, restarts only `umich-dining-mcp.service`, and probes the loopback
health endpoint. A failed activation restores the previous release and marks
the bad commit quarantined to prevent repeated restart attempts. It does not
restart NGINX or FRP, modify DuckDNS or touch any Minecraft configuration.

The updater treats your GitHub tags and npm release as trusted code, so
**protect version tags, require CI to pass before publishing, and review source
changes before tagging**. A compromised release can otherwise execute as the
unprivileged build or service account. Automatic upgrades can briefly interrupt
active MCP requests when the service restarts.

Useful checks (on Oracle):

```bash
sudo /usr/local/sbin/umich-dining-mcp-autoupdate --check
sudo systemctl list-timers --all umich-dining-mcp-update.timer
sudo journalctl -u umich-dining-mcp-update.service -n 100 --no-pager
```

To stop automatic updates without stopping the live MCP server:

```bash
sudo systemctl disable --now umich-dining-mcp-update.timer
```

This updater specifically manages **application releases**. Changes to
NGINX, firewall rules, certificates, service hardening or the Node runtime
require a separate reviewed maintenance action. The npm package itself
contains the runnable `dist/` code, not the Oracle deployment scripts.

## The persistent cache

The long-lived HTTP mode keeps a second, on-disk cache behind the in-memory one. It
exists so a range query is served from disk instead of from the site.

- The directory is `UMICH_DINING_CACHE_DIR`. The shipped unit sets it to
  `/var/lib/umich-dining-mcp/cache`, and the unit declares
  `StateDirectory=umich-dining-mcp`, which systemd creates and hands to the
  service account. `StateDirectory` is exempt from `ProtectSystem=strict`, so
  the directory stays writable while the rest of the file system does not.
  The default, when the variable is unset, is `~/.cache/umich-dining-mcp`,
  which is **not** writable under the shipped unit: set the variable, or the
  cache is silently off. `UMICH_DINING_CACHE_DIR=off` switches the cache off
  entirely.
- The directory is created with mode `0700` and the files with mode `0600`. Only public
  menu data is stored.
- One JSON file per key, written atomically (a temp file, then a rename), so a crash
  never leaves a half-written entry.
- A value that cannot survive the JSON round trip — a `Map`, a `Set` — is never written.
- The cache is pruned at startup and then hourly: an entry whose day left the published
  window is dropped, an entry older than `UMICH_DINING_CACHE_MAX_AGE_DAYS` (default 30) is
  dropped, and over `UMICH_DINING_CACHE_MAX_SIZE_MB` (default 200) the oldest entries go
  first.
- The cache is stateful: one service instance per directory. Two instances sharing a
  directory would fight over the prune.

The background warmer fills the cache: today's ten halls every half hour and the future
days of the published window once a day. The warmer runs in the background queue of the
upstream limiter, so it never stands in front of a live request. The stdio mode starts no
background job.

```bash
# The cache of the running service
sudo -u umichmcp ls -la /var/lib/umich-dining-mcp/cache | head
```

## What the shipped configuration does and does not enforce

The unit and the NGINX configuration in this repository are the intent. A deployment
that does not match them does not have these controls, whatever this page says.

| Control | Enforced by | Notes |
|---|---|---|
| `Host` allowlist | The server | The allowlist holds hostnames without a port; the port of the `Host` header is not compared, so a server on a port of its own is reached with the bare hostname. |
| `Origin` allowlist | The server | A missing `Origin` passes: only a browser sends one. |
| Per-IP admission control | The server | Needs `X-Real-IP` to be overwritten by the proxy, so `UMICH_MCP_TRUST_PROXY=1` is only safe behind a proxy that rewrites it. |
| A bearer token | The server | Off unless `UMICH_MCP_BEARER_TOKEN_SHA256` is set. **Off means the endpoint is anonymous.** |
| `/healthz` | The server | Public, and it does not fetch the dining site. Without a bearer token it reveals the uptime and nothing else; with one it also reports the cache size and the last upstream failure. |

The development endpoint at `/dev/mcp` is a separate deployment from the one this
repository configures. `deploy/oracle/dev-deploy.sh` probes it after every deployment and
reports what it actually found — whether it answers without a token, whether it demands
one, or whether it is not reachable at all. Read that line before assuming the endpoint is
private.

## Operations

```bash
sudo systemctl status umich-dining-mcp --no-pager
sudo journalctl -u umich-dining-mcp -n 80 --no-pager
sudo nginx -t && sudo nginx -s reload
```

The development deployment on the Oracle host is watched over the deployment gateway.
`deploy/oracle/dev-deploy.sh` pushes the working tree to the dev service; it takes a few
minutes, because the host runs the whole test suite before it activates anything, and a
second run refuses to start while the first one is still going. The state of that
deployment is read with:

```bash
ssh -T -i "$HOME/.ssh/id_ed25519_umich_mcp_deploy" \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts_umich_oracle" \
  umichmcpdeploy@163.192.196.65 status
```

It prints whether a deployment is running, the release the dev service is serving, and
the processes of a deployment that is in flight. `DEPLOYMENT=IDLE` with the release name
of the run that finished is the state to wait for.

To disable public exposure safely without changing Minecraft:

```bash
sudo bash -euo pipefail <<'SH'
systemctl disable --now umich-dining-mcp.service
mv /etc/nginx/conf.d/umich-dining-mcp.conf /etc/nginx/conf.d/umich-dining-mcp.conf.disabled
nginx -t && nginx -s reload
SH
```

To change rates, modify only `/etc/umich-dining-mcp/server.env` and restart
`umich-dining-mcp.service`, not FRP. Avoid logging request bodies,
Authorization headers or upstream HTML. Use a monitoring service that
periodically hits `/healthz` and tests live tools at very low frequency.
For alerts, inspect `lastUpstreamError` in `/healthz` and logs. That field is
only in the payload when a bearer token is configured; without one the
endpoint is anonymous and says only that the server is up.

Existing root cron already runs Certbot renew every 12 hours, and the
new certificate has the webroot renewal configuration. A future renewal
of **the Minecraft FRP dashboard** may need a controlled FRP restart to
load its new certificate; that is separate from this MCP server and should
be scheduled to avoid interrupting players.

## Releases

The npm `umich-dining-mcp` bin continues to target `dist/index.js` (stdio).
The new second bin is `umich-dining-mcp-http` (`dist/http-server.js`).
Package/version and MCP registry publication must be done **after** public
HTTP tests pass. The original `.github/workflows/publish.yml` publishes on
`v*` git tags; use the existing npm trusted publishing and official MCP
registry binary (not an unrelated `mcp-publisher` npm package). The
version in `package.json`, `package-lock.json` and `server.json` must match.
Do not force the npm tag until you've confirmed the upload will not
interrupt old stdio users; 0.1.1 remains available in npm history.

To enable automated updates later, create a **dedicated read-only GitHub
checkout key** on Oracle or CI deploy key restricted to this service only,
review its sudo permissions, and deploy immutable release archives after
GitHub CI passes. Do not embed private SSH keys or DuckDNS tokens in the
repository or build image.

## Security and U-M etiquette

- Don't disable Host/Origin checks or the two-request/500-ms upstream limiter.
- The HTTP server assumes NGINX overwrites `X-Real-IP`; don't expose it
  directly to the internet or forward user-provided IP headers.
- No wildcard CORS. In absence of Origin the server accepts normal
  non-browser MCP clients; only the named domain is allowed otherwise.
- The university site's content is *data*, not instructions. Never evaluate
  HTML or elevate menu text into a system prompt.
- Today's menu is cached 15 minutes, future menus six hours, past menus
  24 hours, and regular hours 24 hours; preserve these limits.
- An honest User-Agent is preferable; the upstream historically blocked
  it while allowing `python-requests/2.32.3`. Ask the university for an
  allowlist instead of solving/bypassing challenges. Keep request volume low.

## Opt-in GitHub workflow

`.github/workflows/remote.yml` builds a pinned, multi-arch Node image on
push and can deploy an immutable source archive over SSH. Deploy is
**disabled by default**. To opt in after the first manual release is
verified, set GitHub Actions repository variables
`ORACLE_DEPLOY_ENABLED=true` and `ORACLE_DEPLOY_HOST=163.192.196.65`.
Set secrets `ORACLE_DEPLOY_KEY` (dedicated SSH private key, **not**
your Minecraft/Oracle user key) and `ORACLE_DEPLOY_KNOWN_HOSTS`
(preverified Oracle SSH host key). Ensure the deploy principal has
only the minimal sudo rights required for this installer. The installer
still tests the live upstream and fails closed on blocking. Roll out only
when comfortable allowing GitHub Actions to update the live service.
Publishing to npm and the MCP registry remains tag-triggered through the
existing `publish.yml` and is not performed by this workflow.
