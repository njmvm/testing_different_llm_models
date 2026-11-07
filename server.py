#!/usr/bin/env python3
"""
OpenRouter model comparison chat — local server.

Serves the web UI in ./static and proxies requests to OpenRouter so that your
API key stays on your machine (it is never sent to the browser).

Only the Python standard library is used: no pip install needed.

    cp .env.example .env      # then put your key in .env
    python3 server.py         # Windows: python server.py
                              # then open http://127.0.0.1:8000
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
TRANSCRIPTS_DIR = ROOT / "transcripts"

FALLBACK_DEFAULT_MODELS = [
    "anthropic/claude-sonnet-5.5",
    "openai/gpt-6.1-sol",
    "google/gemini-4-argon",
    "deepseek/deepseek-v4.1-flash",
    "mistralai/mistral-large-4-0",
]

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

MAX_BODY_BYTES = 10 * 1024 * 1024  # 10 MB, plenty for long chats
MODELS_CACHE_SECONDS = 600


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, # comments, optional quotes.
    Real environment variables take precedence over the file."""
    if not path.is_file():
        return
    raw_bytes = path.read_bytes()
    # Windows editors / PowerShell redirection may save UTF-16 or UTF-8 with BOM.
    if raw_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw_bytes.decode("utf-16")
    else:
        text = raw_bytes.decode("utf-8-sig", errors="replace")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv(ROOT / ".env")

API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
DEFAULT_MODELS = [
    m.strip()
    for m in os.environ.get("DEFAULT_MODELS", ",".join(FALLBACK_DEFAULT_MODELS)).split(",")
    if m.strip()
]
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "300"))

_models_cache: dict = {"at": 0.0, "data": None}
_models_lock = threading.Lock()


def upstream_headers() -> dict:
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        # Optional OpenRouter attribution headers.
        "HTTP-Referer": "http://localhost",
        "X-Title": "LLM Model Comparison Chat",
    }


def fetch_models() -> list[dict]:
    """Return a trimmed list of OpenRouter models (cached for 10 minutes)."""
    with _models_lock:
        if _models_cache["data"] is not None and time.time() - _models_cache["at"] < MODELS_CACHE_SECONDS:
            return _models_cache["data"]

    req = urllib.request.Request(f"{BASE_URL}/models", headers=upstream_headers())
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)

    models = []
    for m in payload.get("data", []):
        arch = m.get("architecture") or {}
        outputs = arch.get("output_modalities") or ["text"]
        if "text" not in outputs:
            continue  # skip image/audio-only generators
        pricing = m.get("pricing") or {}
        models.append(
            {
                "id": m.get("id"),
                "name": m.get("name") or m.get("id"),
                "description": (m.get("description") or "")[:400],
                "context_length": m.get("context_length"),
                "created": m.get("created"),
                "prompt_price": _to_float(pricing.get("prompt")),
                "completion_price": _to_float(pricing.get("completion")),
                "supports_reasoning": "reasoning" in (m.get("supported_parameters") or []),
            }
        )
    models.sort(key=lambda x: x.get("created") or 0, reverse=True)

    with _models_lock:
        _models_cache.update(at=time.time(), data=models)
    return models


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "ModelCompare/1.0"

    # Quieter, one-line logs.
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib name)
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # ---- helpers ---------------------------------------------------------- #
    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Missing or too large request body")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _serve_static(self, rel: str) -> None:
        rel = rel.lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---- routes ----------------------------------------------------------- #
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            self._send_json({"has_key": bool(API_KEY), "default_models": DEFAULT_MODELS})
        elif path == "/api/models":
            try:
                self._send_json({"data": fetch_models()})
            except Exception as exc:  # network error, bad key, ...
                self._send_json({"error": f"Could not load models: {exc}"}, 502)
        elif path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            body = self._read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json({"error": f"Bad request: {exc}"}, 400)
            return

        if path == "/api/chat":
            self._proxy_chat(body)
        elif path == "/api/transcripts":
            self._save_transcript(body)
        else:
            self._send_json({"error": "Not found"}, 404)

    # ---- chat proxy (streams Server-Sent Events back to the browser) ----- #
    def _proxy_chat(self, body: dict) -> None:
        if not API_KEY:
            self._send_json(
                {"error": "OPENROUTER_API_KEY is not set. Add it to the .env file and restart the server."},
                400,
            )
            return

        model = body.get("model")
        messages = body.get("messages")
        if not isinstance(model, str) or not isinstance(messages, list) or not messages:
            self._send_json({"error": "'model' and 'messages' are required"}, 400)
            return

        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "usage": {"include": True},  # OpenRouter: return token counts + cost
        }
        for key in ("temperature", "max_tokens", "top_p", "seed"):
            if body.get(key) is not None:
                payload[key] = body[key]
        if body.get("reasoning"):
            payload["reasoning"] = body["reasoning"]

        req = urllib.request.Request(
            f"{BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=upstream_headers(),
            method="POST",
        )

        try:
            upstream = urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT)
        except urllib.error.HTTPError as exc:
            self._send_json({"error": _extract_error(exc)}, exc.code)
            return
        except Exception as exc:
            self._send_json({"error": f"Could not reach OpenRouter: {exc}"}, 502)
            return

        # HTTP/1.0 response without Content-Length: body ends when we close.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            with upstream:
                while True:
                    line = upstream.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    if line in (b"\n", b"\r\n"):
                        self.wfile.flush()
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser pressed "Stop" — closing upstream cancels generation
        except Exception as exc:  # upstream died mid-stream
            try:
                err = json.dumps({"error": {"message": f"Stream interrupted: {exc}"}})
                self.wfile.write(f"data: {err}\n\n".encode("utf-8"))
                self.wfile.flush()
            except Exception:
                pass

    # ---- transcripts ------------------------------------------------------ #
    def _save_transcript(self, body: dict) -> None:
        markdown = body.get("markdown")
        data = body.get("data")
        if not isinstance(markdown, str):
            self._send_json({"error": "'markdown' is required"}, 400)
            return
        title = str(body.get("title") or "comparison")
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-").lower()[:60] or "comparison"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        TRANSCRIPTS_DIR.mkdir(exist_ok=True)
        md_path = TRANSCRIPTS_DIR / f"{stamp}_{slug}.md"
        md_path.write_text(markdown, encoding="utf-8")
        if data is not None:
            md_path.with_suffix(".json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        self._send_json({"saved": str(md_path.relative_to(ROOT))})


def _extract_error(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
        data = json.loads(raw)
        err = data.get("error", data)
        if isinstance(err, dict):
            msg = err.get("message") or json.dumps(err)
            meta = err.get("metadata") or {}
            if isinstance(meta, dict) and meta.get("raw"):
                msg += f" ({str(meta['raw'])[:300]})"
            return f"HTTP {exc.code}: {msg}"
        return f"HTTP {exc.code}: {err}"
    except Exception:
        return f"HTTP {exc.code}: {exc.reason}"


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"Model comparison chat running on http://{HOST}:{PORT}")
    if not API_KEY:
        print("WARNING: OPENROUTER_API_KEY is not set - copy .env.example to .env and add your key.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye!")


if __name__ == "__main__":
    main()
