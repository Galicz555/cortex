# /// script
# requires-python = ">=3.13"
# dependencies = ["scrapling[fetchers]==0.4.15"]
# ///
"""Print the readable text of one web page on stdout.

Exit status 3 means robots.txt forbids the page; any other failure is a non-zero exit with the
reason on stderr. Polite: honours robots.txt and backs off on 429/5xx, respecting Retry-After.
Only http(s) URLs whose host resolves to public addresses are requested, redirect hops included.
"""
import ipaddress
import socket
import sys
import time
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from scrapling.fetchers import Fetcher

RETRY_STATUSES = {429, 500, 502, 503, 504}
BACKOFF_S = (30, 120)
MAX_WAIT_S = 300
ROBOTS_FORBIDDEN = 3
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 10
# The first of these a page has is its content; navigation and footers sit outside it.
CONTENT_SELECTORS = ("article", "main", "[role=main]", "body")


class Refused(Exception):
    pass


def require_public(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Refused(f"refused {url}: not an http(s) URL")
    try:
        infos = socket.getaddrinfo(parts.hostname, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as e:
        raise RuntimeError(f"cannot resolve {parts.hostname}: {e}") from e
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(str(sockaddr[0]).split("%")[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise Refused(f"refused {url}: {ip} is not public")


def header(page, name: str) -> str | None:
    return next((v for k, v in page.headers.items() if k.lower() == name), None)


def get_public(url: str):
    """Fetcher.get that follows redirects itself, checking every hop's address first."""
    for _ in range(MAX_REDIRECTS + 1):
        require_public(url)
        page = Fetcher.get(url, stealthy_headers=True, retries=1, follow_redirects=False)
        location = header(page, "location")
        if page.status not in REDIRECT_STATUSES or not location:
            return page
        url = urljoin(url, location)
    raise RuntimeError(f"more than {MAX_REDIRECTS} redirects")


def is_allowed_by_robots(url: str) -> bool:
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(url))
    try:
        resp = get_public(origin + "/robots.txt")
    except Exception:
        return True  # unreachable robots.txt = no rules
    if resp.status != 200:
        return True
    rules = RobotFileParser()
    rules.parse(resp.body.decode("utf-8", "replace").splitlines())
    return rules.can_fetch("*", url)


def retry_after(page) -> float | None:
    value = header(page, "retry-after")
    return float(value) if value and value.strip().isdigit() else None


def fetch(url: str):
    problem = ""
    for backoff in (*BACKOFF_S, None):
        try:
            page = get_public(url)
            if page.status not in RETRY_STATUSES:
                return page
            problem, wait = f"HTTP {page.status}", retry_after(page)
        except Refused:
            raise
        except Exception as e:
            problem, wait = str(e), None
        if backoff is None:
            break
        time.sleep(min(max(wait or 0, backoff), MAX_WAIT_S))
    raise RuntimeError(problem)


def extract_text(page) -> str:
    for selector in CONTENT_SELECTORS:
        if nodes := page.css(selector):
            return "\n\n".join(node.get_all_text(separator="\n", strip=True) for node in nodes)
    return ""


def main(url: str) -> None:
    if not is_allowed_by_robots(url):
        print(f"robots.txt forbids {url}", file=sys.stderr)
        sys.exit(ROBOTS_FORBIDDEN)
    try:
        page = fetch(url)
    except Refused as e:
        sys.exit(str(e))
    if page.status != 200:
        sys.exit(f"HTTP {page.status} for {url}")
    print(extract_text(page))


if __name__ == "__main__":
    main(sys.argv[1])
