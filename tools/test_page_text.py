# /// script
# requires-python = ">=3.13"
# dependencies = ["scrapling[fetchers]==0.4.15"]
# ///
"""Address checks of page_text.py, offline: `uv run --script tools/test_page_text.py`."""
import page_text


class FakePage:
    def __init__(self, status: int, location: str | None = None):
        self.status = status
        self.headers = {"Location": location} if location else {}


def serve(*pages: FakePage) -> list[str]:
    requested: list[str] = []

    def get(url: str, **_kwargs):
        requested.append(url)
        return pages[len(requested) - 1]

    page_text.Fetcher.get = get
    return requested


def is_refused(url: str, *pages: FakePage) -> bool:
    serve(*pages)
    try:
        page_text.fetch(url)
    except Exception as e:
        return "refused" in str(e)
    return False


REFUSED = {
    "file scheme": "file:///etc/passwd",
    "ftp scheme": "ftp://example.com/x",
    "loopback name": "http://localhost/",
    "IPv4 loopback": "http://127.0.0.1/",
    "IPv4 loopback, integer form": "http://2130706433/",
    "IPv6 loopback": "http://[::1]/",
    "RFC 1918 10/8": "http://10.1.2.3/",
    "RFC 1918 172.16/12": "http://172.20.0.1/",
    "RFC 1918 192.168/16": "http://192.168.1.1/",
    "IPv6 unique local": "http://[fd12:3456::1]/",
    "IPv4 link-local": "http://169.254.169.254/",
    "IPv6 link-local": "http://[fe80::1]/",
    "shared address space, hex form": "http://0x64400001/",
    "IPv4 unspecified": "http://0.0.0.0/",
    "IPv6 unspecified": "http://[::]/",
    "IPv4 multicast": "http://224.0.0.251/",
    "IPv6 multicast": "http://[ff02::1]/",
    "IPv4-mapped loopback": "http://[::ffff:127.0.0.1]/",
}

if __name__ == "__main__":
    for name, url in REFUSED.items():
        assert is_refused(url, FakePage(200)), f"{name}: {url} was fetched"
    assert is_refused("https://1.1.1.1/", FakePage(302, "http://127.0.0.1/admin")), "redirect"
    assert is_refused("https://1.1.1.1/", FakePage(301, "file:///etc/passwd")), "redirect scheme"

    requested = serve(FakePage(301, "/moved"), FakePage(200))
    assert page_text.fetch("https://1.1.1.1/old").status == 200
    assert requested == ["https://1.1.1.1/old", "https://1.1.1.1/moved"], requested
    print(f"ok: {len(REFUSED) + 2} refusals, 1 allowed redirect")
