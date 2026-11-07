"""A tiny fake OpenRouter API used by the tests (and handy for UI work offline).

    python3 tests/mock_openrouter.py 8765
    OPENROUTER_BASE_URL=http://127.0.0.1:8765/api/v1 OPENROUTER_API_KEY=test python3 server.py
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = [
    {"id": "acme/alpha", "name": "Acme: Alpha", "created": 2, "context_length": 128000,
     "pricing": {"prompt": "0.000001", "completion": "0.000002"},
     "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["reasoning"]},
    {"id": "acme/beta:free", "name": "Acme: Beta (free)", "created": 1, "context_length": 32000,
     "pricing": {"prompt": "0", "completion": "0"}, "architecture": {"output_modalities": ["text"]}},
    {"id": "acme/painter", "name": "Acme: Painter", "created": 3,
     "pricing": {"prompt": "0", "completion": "0"}, "architecture": {"output_modalities": ["image"]}},
]


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": MODELS}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer test":
            return self._error(401, "No auth credentials found")
        if req["model"] == "acme/broken":
            return self._error(404, "No endpoints found for acme/broken")
        last = req["messages"][-1]["content"]
        n_turns = sum(1 for m in req["messages"] if m["role"] == "user")
        system = next((m["content"] for m in req["messages"] if m["role"] == "system"), "")
        answer = (f"**{req['model']}** answers turn {n_turns}: _{last}_\n\n"
                  f"- system prompt seen: {'yes' if system else 'no'}\n- temperature: {req.get('temperature')}\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b": OPENROUTER PROCESSING\n\n")
        if req.get("reasoning"):
            self._chunk({"choices": [{"delta": {"reasoning": "Let me think about this. "}}]})
        for word in answer.split(" "):
            self._chunk({"provider": "MockProvider", "choices": [{"delta": {"content": word + " "}}]})
            time.sleep(0.01)
        self._chunk({"choices": [{"delta": {}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 42, "completion_tokens": 17, "cost": 0.000123}})
        self.wfile.write(b"data: [DONE]\n\n")

    def _chunk(self, obj):
        self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
        self.wfile.flush()

    def _error(self, code, msg):
        body = json.dumps({"error": {"code": code, "message": msg}}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(port):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Mock)
    httpd.daemon_threads = True
    return httpd


if __name__ == "__main__":
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8765).serve_forever()
