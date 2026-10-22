#!/usr/bin/env python3
"""Pull published tagged UMich Dining releases from GitHub; activate with rollback.

This runs ONLY on the owner's Oracle VM. It intentionally does not touch
NGINX, TLS certificates, FRP or Minecraft. Invoked by the systemd timer.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

BASE = Path('/opt/umich-dining-mcp')
RELEASES = BASE / 'releases'
CURRENT = BASE / 'current'
NODE = BASE / 'node' / 'bin'
STATE = Path('/var/lib/umich-mcp-updater')
GITHUB_TAGS = 'https://api.github.com/repos/esreddy2/UMich-dining-mcp/tags?per_page=100'
NPM_LATEST = 'https://registry.npmjs.org/umich-dining-mcp/latest'
DOMAIN = 'umich-dining-mcp.duckdns.org'
VERSION_RE = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')
SHA_RE = re.compile(r'^[a-f0-9]{40}$')
MAX_ZIP_BYTES = 25 * 1024 * 1024
MAX_UNPACKED_BYTES = 120 * 1024 * 1024


def say(message: str) -> None:
    print(message, flush=True)


def request(url: str, *, max_bytes: int = 1_000_000, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={
        'User-Agent': 'umich-dining-mcp-oracle-release-updater/1.0',
        'Accept': 'application/vnd.github+json' if 'api.github.com' in url else 'application/octet-stream',
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f'Unexpected HTTP {response.status} from source')
        content = response.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise RuntimeError('Remote response exceeds safety limit')
        return content


def json_request(url: str) -> object:
    return json.loads(request(url))


def tag_version(value: str) -> tuple[int, int, int] | None:
    match = VERSION_RE.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


def current_version() -> tuple[int, int, int]:
    if not CURRENT.is_symlink():
        raise RuntimeError('Current application symlink is missing')
    resolved = CURRENT.resolve(strict=True)
    if resolved.parent != RELEASES.resolve(strict=True):
        raise RuntimeError('Current application symlink points outside managed releases')
    package = json.loads((resolved / 'package.json').read_text())
    v = tag_version('v' + str(package['version']))
    if v is None:
        raise RuntimeError('Current application version is not a stable release')
    return v


def next_release() -> tuple[tuple[int, int, int], str, str] | None:
    tags = json_request(GITHUB_TAGS)
    if not isinstance(tags, list):
        raise RuntimeError('GitHub tags response has unexpected format')
    candidates = []
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        name = tag.get('name')
        v = tag_version(name) if isinstance(name, str) else None
        commit = tag.get('commit')
        sha = commit.get('sha') if isinstance(commit, dict) else None
        if v is not None and isinstance(sha, str) and SHA_RE.fullmatch(sha):
            candidates.append((v, name, sha))
    return max(candidates, default=None)


def run(*args: str, timeout: int = 120, user: str | None = None) -> None:
    cmd = list(args)
    if user:
        cmd = ['runuser', '-u', user, '--', *cmd]
    subprocess.run(cmd, check=True, timeout=timeout)


def healthy() -> bool:
    try:
        url = 'http://127.0.0.1:8080/healthz'
        req = urllib.request.Request(url, headers={'Host': DOMAIN})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=2) as resp:
            value = json.loads(resp.read(4096))
            return resp.status == 200 and value.get('status') == 'ok'
    except (OSError, urllib.error.URLError, ValueError, TimeoutError):
        return False


def wait_healthy(seconds: int = 45) -> bool:
    for _ in range(seconds):
        if healthy():
            return True
        time.sleep(1)
    return False


def upstream_available() -> None:
    # Same conservative go/no-go as the initial installer; no challenge bypass.
    url = 'https://dining.umich.edu/menus-locations/dining-halls/bursley/'
    req = urllib.request.Request(url, headers={'User-Agent': 'python-requests/2.32.3'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=25) as resp:
        if resp.status != 200:
            raise RuntimeError('University upstream HTTP status is not 200')
        snippet = resp.read(8192).lower()
        if any(k in snippet for k in (
            b'cf-browser-verification', b'cf_chl_opt', b'challenge-platform',
            b'just a moment', b'attention required',
        )):
            raise RuntimeError('University upstream presented a challenge; not deploying')
    say('UPSTREAM_PREFLIGHT=PASS')


def download_and_unpack(sha: str, stage: Path) -> None:
    url = f'https://codeload.github.com/esreddy2/UMich-dining-mcp/zip/{sha}'
    contents = request(url, max_bytes=MAX_ZIP_BYTES, timeout=90)
    archive = stage / '.source.zip'
    archive.write_bytes(contents)
    unpack = stage / '.source'
    unpack.mkdir()
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) > 5000 or sum(i.file_size for i in entries) > MAX_UNPACKED_BYTES:
            raise RuntimeError('Release archive exceeds extraction limits')
        for info in entries:
            path = Path(info.filename)
            mode = info.external_attr >> 16
            if path.is_absolute() or '..' in path.parts or (mode & 0o170000) == 0o120000:
                raise RuntimeError('Unsafe archive path or symlink')
            if info.is_dir():
                continue
            if (mode & 0o170000) not in (0, 0o100000):
                raise RuntimeError('Unexpected archive object type')
        z.extractall(unpack)
    roots = [p for p in unpack.iterdir() if p.is_dir()]
    if len(roots) != 1 or not (roots[0] / 'package-lock.json').is_file():
        raise RuntimeError('Archive did not contain one valid repository root')
    for src in roots[0].iterdir():
        shutil.move(str(src), str(stage / src.name))
    shutil.rmtree(unpack)
    archive.unlink()


def require_release_version(stage: Path, version: str) -> None:
    manifest = json.loads((stage / 'package.json').read_text())
    lockfile = json.loads((stage / 'package-lock.json').read_text())
    if (manifest.get('name') != 'umich-dining-mcp'
            or manifest.get('version') != version
            or lockfile.get('version') != version
            or lockfile.get('packages', {}).get('', {}).get('version') != version):
        raise RuntimeError('GitHub tag version differs from package/lockfile version')
    if not (stage / 'src' / 'http-server.ts').is_file():
        raise RuntimeError('GitHub source is missing the HTTP server')


def build_as_unprivileged_user(stage: Path) -> None:
    builder = 'umichmcpbuild'
    import pwd
    info = pwd.getpwnam(builder)
    for root, dirs, files in os.walk(stage):
        os.chown(root, info.pw_uid, info.pw_gid)
        for child in dirs + files:
            os.chown(os.path.join(root, child), info.pw_uid, info.pw_gid, follow_symlinks=False)
    os.chown(stage, info.pw_uid, info.pw_gid)
    env = [
        'env', f'PATH={NODE}:/usr/bin:/bin', 'HOME=/var/lib/umichmcpbuild',
        'sh', '-c',
        'cd "$1" && npm ci --ignore-scripts --no-audit --no-fund'
        ' && npm run typecheck && npm run lint && npm test'
        ' && npm run test:oracle && npm run build'
        ' && npm prune --omit=dev --ignore-scripts --no-audit --no-fund',
        'sh', str(stage),
    ]
    say('BUILDING_AND_TESTING_AS=umichmcpbuild')
    run(*env, user=builder, timeout=1200)
    if not (stage / 'dist' / 'http-server.js').is_file():
        raise RuntimeError('Expected compiled HTTP server is absent')
    # Root owns deployed code; the running MCP process can read but not modify it.
    for root, dirs, files in os.walk(stage):
        os.chown(root, 0, 0)
        for child in dirs + files:
            path = Path(root) / child
            os.chown(path, 0, 0, follow_symlinks=False)
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    stage.chmod(0o755)


def verify_prerequisites() -> None:
    if os.geteuid() != 0 or socket.gethostname().split('.')[0] != 'dcc':
        raise RuntimeError('Updater must run as root on Oracle hostname dcc')
    if not (NODE / 'node').is_file() or not (NODE / 'npm').exists():
        raise RuntimeError('Private Node runtime missing')
    if not (BASE / 'current').is_symlink():
        raise RuntimeError('App has not been deployed yet')
    if not (Path('/etc/umich-dining-mcp/server.env')).is_file():
        raise RuntimeError('MCP runtime environment missing')
    if not (Path('/etc/nginx/conf.d/umich-dining-mcp.conf')).is_file():
        raise RuntimeError('MCP NGINX site missing')
    run('systemctl', 'is-active', '--quiet', 'umich-dining-mcp.service')
    run('systemctl', 'is-active', '--quiet', 'frps.service')
    if not healthy():
        raise RuntimeError('MCP service is not already healthy; refusing automatic update')


def deploy(v: tuple[int, int, int], sha: str) -> None:
    version = '.'.join(map(str, v))
    failed_file = STATE / f'failed-{sha}'
    if failed_file.exists():
        say(f'SKIPPED_QUARANTINED_SHA={sha}')
        return
    stage = Path(tempfile.mkdtemp(prefix='.autoupdate-', dir=RELEASES))
    old_link = os.readlink(CURRENT)
    activated = False
    build_started = False
    try:
        upstream_available()
        download_and_unpack(sha, stage)
        require_release_version(stage, version)
        build_started = True
        build_as_unprivileged_user(stage)
        release = RELEASES / f'{version}-{sha[:12]}'
        if release.exists() or release.is_symlink():
            raise RuntimeError('Release directory exists but is not active; manual review required')
        os.rename(stage, release)
        stage = None
        temporary = BASE / f'.current-update-{os.getpid()}'
        try:
            os.symlink(f'releases/{release.name}', temporary)
            os.replace(temporary, CURRENT)
        finally:
            if temporary.is_symlink():
                temporary.unlink()
        activated = True
        say(f'ACTIVATING_VERSION={version}')
        run('systemctl', 'restart', 'umich-dining-mcp.service', timeout=60)
        if not wait_healthy():
            raise RuntimeError('Updated application failed health check')
        say(f'DEPLOYED_VERSION={version}')
        say(f'GITHUB_COMMIT={sha}')
    except Exception as exc:
        say(f'UPDATE_ERROR={type(exc).__name__}: {exc}')
        if build_started:
            # Avoid burning CPU every 30 minutes on a permanently bad release.
            failed_file.write_text(f'{version}\n{sha}\n{exc}\n')
        if activated:
            # Failed release cannot flap every timer cycle; need new tag or manual review.
            failed_file.write_text(f'{version}\n{sha}\n{exc}\n')
            temp = BASE / f'.current-rollback-{os.getpid()}'
            try:
                os.symlink(old_link, temp)
                os.replace(temp, CURRENT)
                run('systemctl', 'restart', 'umich-dining-mcp.service', timeout=60)
                if not wait_healthy():
                    raise RuntimeError('ROLLBACK FAILED: original application did not recover')
                say('ROLLBACK=SUCCESS')
            finally:
                if temp.is_symlink():
                    temp.unlink()
        raise
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true', help='read-only release availability check')
    group.add_argument('--apply', action='store_true', help='deploy a newer published stable release')
    args = parser.parse_args()
    verify_prerequisites()
    existing = current_version()
    say('CURRENT_VERSION=' + '.'.join(map(str, existing)))
    tag = next_release()
    if tag is None:
        say('NO_STABLE_GITHUB_TAGS')
        return 0
    latest, name, sha = tag
    say(f'LATEST_GITHUB_TAG={name}')
    say(f'LATEST_GITHUB_SHA={sha}')
    if latest <= existing:
        say('UPDATE_STATUS=UP_TO_DATE')
        return 0
    npm = json_request(NPM_LATEST)
    published = tag_version('v' + str(npm.get('version', ''))) if isinstance(npm, dict) else None
    say(f'LATEST_NPM_VERSION={npm.get("version") if isinstance(npm, dict) else "unknown"}')
    if published != latest:
        say('UPDATE_STATUS=WAITING_FOR_MATCHING_NPM_PUBLICATION')
        return 0
    say('UPDATE_STATUS=READY')
    if args.check:
        return 0
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / '.deploy.lock').open('a+') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            say('UPDATE_STATUS=ANOTHER_DEPLOYMENT_RUNNING')
            return 0
        # Guard against simultaneous/manual changes after querying sources.
        if current_version() >= latest:
            say('UPDATE_STATUS=ALREADY_DEPLOYED')
            return 0
        deploy(latest, sha)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        say(f'UPDATE_FAILED={type(exc).__name__}: {exc}')
        sys.exit(1)
