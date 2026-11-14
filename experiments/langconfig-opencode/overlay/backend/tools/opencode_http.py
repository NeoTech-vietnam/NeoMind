"""Bounded loopback-only transport for an explicitly owned test instance."""
import json
from urllib.parse import urlsplit

import httpx


class TransportError(RuntimeError):
    pass


class LoopbackTransport:
    fixture_only = True
    def __init__(self, origin: str, username: str, password: str, timeout: float = 20):
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("origin must be a fixed IPv4 loopback origin")
        self.origin = f"http://127.0.0.1:{parsed.port}"
        self.auth = (username, password)
        self.timeout = timeout

    async def request(self, method, path, body=None):
        if method not in ("GET", "POST") or not path.startswith("/api/") or path.startswith("//") or "#" in path:
            raise TransportError("invalid request")
        try:
            async with httpx.AsyncClient(base_url=self.origin, auth=self.auth, timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                async with client.stream(method, path, json=body) as response:
                    if response.status_code == 204:
                        return None
                    if not 200 <= response.status_code < 300:
                        raise TransportError(f"OpenCode HTTP status {response.status_code}")
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 2_000_000:
                            raise TransportError("OpenCode response too large")
                    return json.loads(chunks)
        except TransportError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise TransportError("OpenCode transport failure or invalid response") from exc
