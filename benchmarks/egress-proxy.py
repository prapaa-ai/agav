#!/usr/bin/env python3
"""
Denylist/allowlist egress proxy for agav benchmark re-runs (anti reward-hacking).

Why this exists
---------------
On plain re-runs the agent fetches the benchmark repo / leaked solutions, which
turns real failures into fake passes. Disabling agav's fetch tools is NOT
airtight (shell curl/git bypass) and AGAV_PERMISSION deny flips agav into global
"deny-writes" (breaks legit tasks). The only side-effect-free layer is network
egress control.

Observed adversarial behavior (mteb-leaderboard__FsybnJg, 2026-08-11): with a
plain hostname denylist the agent DEFEATED it via
  * reader-proxies (r.jina.ai) that fetch a blocked URL server-side, and
  * leaked mirrors on shared allowed hosts (huggingface.co/HKasar1239, and a new
    github mirror mintoriakamoto/AI-Bench-MoeX).
So this version (a) always blocks reader-proxies/caches + all known mirrors
FIRST, and (b) offers an optional strict allowlist mode (--strict) that blocks
everything not explicitly allowed.

Design constraints
------------------
* NO TLS interception (no CA -> would change the task image / break model calls).
  Filtering is on the CONNECT hostname (and Host header for plain HTTP) only.
* Because HTTPS hides the URL path, two vectors CANNOT be stopped by hostname and
  remain residual even in --strict: (1) a leak hosted on a shared allowed host
  (huggingface.co/HKasar1239), (2) a mirror cloned from github.com. The
  full-channel canary/benchmark-host GREP over each finished trajectory stays the
  MANDATORY authoritative gate.

Usage
-----
    python3 benchmarks/egress-proxy.py                 # denylist-only (default)
    python3 benchmarks/egress-proxy.py --strict        # default-deny allowlist
    python3 benchmarks/egress-proxy.py --log /tmp/egress-blocks.log

Then, before re-running:
    export AGAV_EGRESS_PROXY=http://host.docker.internal:8080
    EXTRA="-n 1" JOB_NAME=tb21-agav-full ./benchmarks/run-tasks.sh --all
"""

import argparse
import select
import socket
import sys
import threading
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# ALWAYS-DENIED host suffixes (checked FIRST, in both modes). Suffix match:
# "spylab.ai" blocks "spylab.ai" and "x.spylab.ai".
# --------------------------------------------------------------------------
DENY_SUFFIXES = [
    # --- search engines (mirror/leak DISCOVERY channel; 0 legit fetches to
    # these hosts observed among clean reward=1 trials, so denylist them even in
    # default-allow mode). Note: these suffixes do NOT match googleapis.com /
    # gstatic.com / google.dev, which stay allowed. ---
    "duckduckgo.com",               # agav web_search backend (html.duckduckgo.com)
    "bing.com",
    "google.com",                   # www.google.com/search (NOT *.googleapis.com)
    "search.brave.com",
    "search.marginalia.nu",
    # --- benchmark repo browse/raw APIs (dominant vector) ---
    "api.github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    # --- known leak / mirror hosts ---
    "hub.harborframework.com",
    "harborframework.com",
    "tbench.ai",
    "spylab.ai",
    "solutions-spylab.github.io",
    "marginlab.ai",
    "deepwiki.com",
    "hkasar1239.github.io",
    "moogician.github.io",
    # --- reader-proxies / URL-fetch relays / caches (the bypass class) ---
    # These fetch an arbitrary (blocked) URL server-side and return its body,
    # defeating hostname filtering. Block the relay itself.
    "jina.ai",                      # r.jina.ai, s.jina.ai, ...
    "corsproxy.io",
    "allorigins.win",               # api.allorigins.win
    "12ft.io",
    "1ft.io",
    "cors-anywhere.herokuapp.com",
    "thingproxy.freeboard.io",
    "codetabs.com",                 # api.codetabs.com/v1/proxy
    "cors.sh",                      # proxy.cors.sh
    "whateverorigin.org",
    "crossorigin.me",
    "yacdn.org",
    "textance.herokuapp.com",
    "urlreq.appspot.com",
    # --- web caches / archives / translators (also fetch blocked URLs) ---
    "webcache.googleusercontent.com",
    "web.archive.org",
    "archive.org",
    "archive.ph",
    "archive.today",
    "cachedview.nl",
    "translate.goog",               # *.translate.goog (Google Translate relay)
    "translate.google.com",
    "translate.yandex.com",
]

# Substrings that, if present ANYWHERE in the CONNECT host, force a block. Used
# for mirror *accounts* that live on otherwise-allowed hosts is impossible by
# hostname (HTTPS hides the path) -- but standalone mirror domains go here.
DENY_CONTAINS = [
    "harborframework",
    "terminalbench",
]

# --------------------------------------------------------------------------
# ALLOWLIST (only consulted with --strict). Everything not matching (and not in
# DENY above) is refused. Curated to cover legit needs of the re-run tasks +
# hosts actually observed in clean traffic (datawrapper, kennethenevoldsen).
# Extend freely: watch the log for "DENY not-allowlisted <host>" and add it.
# NOTE: github.com and huggingface.co are allowed (legit clones / model pulls) ->
# their leaked-mirror sub-paths are the residual gap the GREP gate must catch.
# --------------------------------------------------------------------------
ALLOW_SUFFIXES = [
    # model / agent APIs
    "api.openai.com", "openai.com", "api.anthropic.com", "anthropic.com",
    # python / pip
    "pypi.org", "pythonhosted.org", "pypi.python.org",
    # conda
    "anaconda.org", "anaconda.com",
    # OS packages
    "debian.org", "ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com",
    # other language package registries
    "registry.npmjs.org", "npmjs.org", "crates.io", "proxy.golang.org",
    "sum.golang.org", "rubygems.org",
    # huggingface (models/datasets/spaces) -- REQUIRED by mteb/hf tasks
    "huggingface.co", "hf.co", "hf.space", "cdn-lfs.huggingface.co",
    "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "datasets-server.huggingface.co",
    "hf-mirror.com",
    # github legit clones / assets (NOT raw/api -- those are denied above)
    "github.com", "codeload.github.com", "objects.githubusercontent.com",
    # common CDNs
    "jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com", "fastly.net",
    # legit hosts observed in clean mteb traffic
    "dwcdn.net", "datawrapper.de", "kennethenevoldsen.com",
    # Scandinavian Embedding Benchmark author's own site (the primary legit
    # source for this task) -- NOT a benchmark grader/mirror. Safe to allow:
    # the denied *.github.io mirror hosts (hkasar1239/moogician/solutions-spylab)
    # are exact suffixes checked FIRST, so this cannot shadow them.
    "kennethenevoldsen.github.io",
    # official POV-Ray project distribution site -- REQUIRED by build-pov-ray to
    # download the legit 2.2 source archive. Upstream project, not a mirror.
    "povray.org",
    # legit POV-Ray distribution MIRRORS the agent falls back to (reputable
    # academic / OS software mirrors carrying Old-Versions/Official-2.2) -- also
    # needed for a clean build-pov-ray solve; none are benchmark/grader hosts.
    "ftp.nluug.nl", "mirrors.dotsrc.org", "ftp.icm.edu.pl", "ftp.fau.de",
    "ftp.uni-erlangen.de",
]

_lock = threading.Lock()
_log_fh = None
_strict = False


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).isoformat()} {msg}"
    with _lock:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
        if _log_fh is not None:
            _log_fh.write(line + "\n")
            _log_fh.flush()


def _norm(host: str) -> str:
    h = host.strip().lower().rstrip(".")
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    return h


def _suffix_match(host: str, suffixes) -> bool:
    for suf in suffixes:
        if host == suf or host.endswith("." + suf):
            return True
    return False


def verdict(host: str) -> tuple[bool, str]:
    """Return (blocked, reason)."""
    h = _norm(host)
    if _suffix_match(h, DENY_SUFFIXES):
        return True, "denylist"
    if any(tok in h for tok in DENY_CONTAINS):
        return True, "denylist(contains)"
    if _strict and not _suffix_match(h, ALLOW_SUFFIXES):
        return True, "not-allowlisted"
    return False, "allow"


def pipe(a: socket.socket, b: socket.socket) -> None:
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 60)
            if x or not r:
                break
            for s in r:
                other = b if s is a else a
                try:
                    data = s.recv(65536)
                except OSError:
                    return
                if not data:
                    return
                try:
                    other.sendall(data)
                except OSError:
                    return
    finally:
        for s in socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def read_headers(sock: socket.socket) -> bytes:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 65536:
            break
    return buf


def _refuse(client: socket.socket) -> None:
    try:
        client.sendall(b"HTTP/1.1 403 Forbidden\r\n"
                       b"Content-Length: 0\r\nConnection: close\r\n\r\n")
    except OSError:
        pass
    client.close()


def handle_connect(client: socket.socket, target: str) -> None:
    host, _, port_s = target.partition(":")
    port = int(port_s) if port_s else 443
    blocked, reason = verdict(host)
    if blocked:
        log(f"BLOCK CONNECT {host}:{port} [{reason}]")
        _refuse(client)
        return
    try:
        upstream = socket.create_connection((host, port), timeout=30)
    except OSError as exc:
        log(f"FAIL  CONNECT {host}:{port} ({exc})")
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
        client.close()
        return
    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    pipe(client, upstream)


def handle_plain_http(client: socket.socket, first_line: str, raw: bytes) -> None:
    try:
        _, url, _ = first_line.split(" ", 2)
    except ValueError:
        client.close()
        return
    hostport = url.split("//", 1)[-1].split("/", 1)[0]
    host, _, port_s = hostport.partition(":")
    port = int(port_s) if port_s else 80
    blocked, reason = verdict(host)
    if blocked:
        log(f"BLOCK HTTP    {host}:{port} {url} [{reason}]")
        _refuse(client)
        return
    try:
        upstream = socket.create_connection((host, port), timeout=30)
    except OSError as exc:
        log(f"FAIL  HTTP    {host}:{port} ({exc})")
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
        client.close()
        return
    upstream.sendall(raw)
    pipe(client, upstream)


def handle_client(client: socket.socket, addr) -> None:
    try:
        client.settimeout(30)
        raw = read_headers(client)
        if not raw:
            client.close()
            return
        first_line = raw.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        method = first_line.split(" ", 1)[0].upper()
        client.settimeout(None)
        if method == "CONNECT":
            handle_connect(client, first_line.split(" ", 2)[1])
        else:
            handle_plain_http(client, first_line, raw)
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR client {addr}: {exc}")
        try:
            client.close()
        except OSError:
            pass


def main() -> int:
    global _log_fh, _strict
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--strict", action="store_true",
                    help="default-deny: block everything not on ALLOW_SUFFIXES "
                         "(may block legit hosts -- watch the log and extend)")
    ap.add_argument("--log", help="also append events to this file")
    args = ap.parse_args()

    _strict = args.strict
    if args.log:
        _log_fh = open(args.log, "a", buffering=1)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(128)
    mode = "STRICT allowlist" if _strict else "denylist-only"
    log(f"egress-proxy on {args.host}:{args.port} mode={mode}; "
        f"deny={len(DENY_SUFFIXES)} suffixes"
        + (f", allow={len(ALLOW_SUFFIXES)} suffixes" if _strict else ""))
    log("residual gaps (hostname-only): github.com mirror clones + "
        "huggingface.co/HKasar1239 -> canary/benchmark-host GREP stays mandatory")
    try:
        while True:
            client, addr = srv.accept()
            threading.Thread(target=handle_client, args=(client, addr),
                             daemon=True).start()
    except KeyboardInterrupt:
        log("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
