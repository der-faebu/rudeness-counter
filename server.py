#!/usr/bin/env python3
"""Rudeness Counter: a tiny offline server.

Serves index.html and keeps every booking in rudeness.json next to it.
Standard library only.

    python3 server.py                 # http://127.0.0.1:8000, this machine only
    python3 server.py --host 0.0.0.0  # let a coworker on the same network join
"""

import argparse
import json
import os
import tempfile
import threading
import uuid
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE / "index.html"
# RUDENESS_DATA overrides where the JSON lives (the Docker image points it at a volume).
DATA = Path(os.environ.get("RUDENESS_DATA", HERE / "rudeness.json")).resolve()

DEFAULT = {"names": {"a": "Player one", "b": "Player two"}, "incidents": []}
LOCK = threading.Lock()


def load():
    try:
        with DATA.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return json.loads(json.dumps(DEFAULT))
    data.setdefault("names", dict(DEFAULT["names"]))
    data.setdefault("incidents", [])
    return data


def save(data):
    DATA.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp file and swap it in, so a crash never leaves half a file.
    fd, tmp = tempfile.mkstemp(dir=DATA.parent, prefix=".rudeness-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, DATA)


def clean_name(value):
    return value.strip()[:28] if isinstance(value, str) else ""


class Handler(BaseHTTPRequestHandler):
    server_version = "RudenessCounter/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 16_384:
            raise ValueError("Request too large")
        raw = self.rfile.read(length) if length else b"{}"
        body = json.loads(raw or b"{}")
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        return body

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = PAGE.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/data":
            with LOCK:
                self.send_json(load())
        else:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if self.path != "/api/incidents":
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        try:
            body = self.read_body()
        except ValueError as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        who, kind = body.get("who"), body.get("kind", "rude")
        if who not in ("a", "b") or kind not in ("rude", "nice"):
            return self.send_json({"error": "who must be a or b, kind must be rude or nice"}, HTTPStatus.BAD_REQUEST)
        # The page sends the day in the viewer's local time; fall back to the server's.
        day = body.get("date") or date.today().isoformat()
        try:
            day = date.fromisoformat(day).isoformat()
        except (TypeError, ValueError):
            return self.send_json({"error": "date must look like 2026-11-25"}, HTTPStatus.BAD_REQUEST)
        quote = body.get("quote")
        incident = {
            "id": uuid.uuid4().hex[:12],
            "who": who,
            "kind": kind,
            "date": day,
            "quote": quote.strip()[:280] if isinstance(quote, str) else "",
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with LOCK:
            data = load()
            data["incidents"].append(incident)
            save(data)
            self.send_json(data, HTTPStatus.CREATED)

    def do_PUT(self):
        if self.path != "/api/names":
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        try:
            body = self.read_body()
        except ValueError as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        with LOCK:
            data = load()
            for side in ("a", "b"):
                name = clean_name(body.get(side))
                if name:
                    data["names"][side] = name
            save(data)
            self.send_json(data)

    def do_DELETE(self):
        prefix = "/api/incidents/"
        if not self.path.startswith(prefix):
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        incident_id = self.path[len(prefix):]
        with LOCK:
            data = load()
            data["incidents"] = [i for i in data["incidents"] if i.get("id") != incident_id]
            save(data)
            self.send_json(data)


def main():
    parser = argparse.ArgumentParser(description="Rudeness Counter server")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"), help="use 0.0.0.0 to share on your network")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Rudeness Counter on http://{args.host}:{args.port}  (data: {DATA})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
