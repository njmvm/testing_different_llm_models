"""Run with:  python3 -m unittest discover -s tests"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import mock_openrouter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mock_port, cls.port = free_port(), free_port()
        cls.mock = mock_openrouter.serve(mock_port)
        threading.Thread(target=cls.mock.serve_forever, daemon=True).start()
        env = dict(os.environ, OPENROUTER_API_KEY="test", PORT=str(cls.port),
                   OPENROUTER_BASE_URL=f"http://127.0.0.1:{mock_port}/api/v1")
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "server.py")], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(cls.url("/api/config"), timeout=1)
                break
            except Exception:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        cls.mock.shutdown()

    @classmethod
    def url(cls, path):
        return f"http://127.0.0.1:{cls.port}{path}"

    def post(self, path, obj):
        req = urllib.request.Request(self.url(path), data=json.dumps(obj).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        return urllib.request.urlopen(req, timeout=10)

    def test_config(self):
        cfg = json.load(urllib.request.urlopen(self.url("/api/config")))
        self.assertTrue(cfg["has_key"])
        self.assertTrue(cfg["default_models"])

    def test_models_filters_non_text(self):
        data = json.load(urllib.request.urlopen(self.url("/api/models")))["data"]
        ids = [m["id"] for m in data]
        self.assertEqual(ids, ["acme/alpha", "acme/beta:free"])
        self.assertEqual(data[1]["prompt_price"], 0.0)

    def test_chat_streams(self):
        resp = self.post("/api/chat", {"model": "acme/alpha", "temperature": 0.3,
                                       "messages": [{"role": "system", "content": "s"},
                                                    {"role": "user", "content": "hello"}]})
        self.assertIn("text/event-stream", resp.headers["Content-Type"])
        text, usage = "", None
        for line in resp.read().decode().splitlines():
            if line.startswith("data: ") and line != "data: [DONE]":
                chunk = json.loads(line[6:])
                text += "".join(c["delta"].get("content", "") for c in chunk["choices"])
                usage = chunk.get("usage") or usage
        self.assertIn("answers turn 1", text)
        self.assertIn("system prompt seen: yes", text)
        self.assertIn("temperature: 0.3", text)
        self.assertEqual(usage["cost"], 0.000123)

    def test_upstream_error_is_forwarded(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post("/api/chat", {"model": "acme/broken", "messages": [{"role": "user", "content": "x"}]})
        self.assertEqual(ctx.exception.code, 404)
        self.assertIn("No endpoints found", json.load(ctx.exception)["error"])

    def test_bad_request(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post("/api/chat", {"model": "acme/alpha"})
        self.assertEqual(ctx.exception.code, 400)

    def test_static_and_traversal(self):
        html = urllib.request.urlopen(self.url("/")).read().decode()
        self.assertIn("Model Compare", html)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/static/../server.py"))
        self.assertIn(ctx.exception.code, (403, 404))

    def test_save_transcript(self):
        out = json.load(self.post("/api/transcripts", {"title": "Unit test run!", "markdown": "# hi", "data": {"a": 1}}))
        path = ROOT / out["saved"]
        try:
            self.assertTrue(path.name.endswith("_unit-test-run.md"))
            self.assertEqual(path.read_text(), "# hi")
            self.assertTrue(path.with_suffix(".json").exists())
        finally:
            path.unlink(missing_ok=True)
            path.with_suffix(".json").unlink(missing_ok=True)
            d = ROOT / "transcripts"
            if d.exists() and not any(d.iterdir()):
                shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
