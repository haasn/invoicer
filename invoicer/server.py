"""Local HTTP server for the browser UI.

Only binds to 127.0.0.1. Since any website can still send requests to
localhost, every request must carry the expected Host header (to defeat DNS
rebinding) and every API request a per-session token that is only embedded
in the served page.
"""

import datetime as dt
import json
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import model, render
from .store import StoreError

BASE = Path(__file__).resolve().parent.parent
STATIC = BASE / "static"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}
CSP = ("default-src 'self'; img-src 'self' data:; frame-src 'self' blob:; "
       "object-src 'self' blob:")


class ApiError(Exception):
    def __init__(self, status, message, problems=None):
        super().__init__(message)
        self.status = status
        self.problems = problems or []


class Pdf(bytes):
    pass


ROUTES = []


def route(method, pattern):
    def wrap(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return wrap


def money(d):
    return model.fmt_money(d)


def annotate(doc, composed=None):
    """Attach computed values (totals, display status) under "_"."""
    composed = composed or doc
    ann = {"status": model.display_status(doc, dt.date.today())}
    try:
        t = model.totals(composed)
        ann.update(net=money(t["net"]), vat=money(t["vat"]), gross=money(t["gross"]),
                   gross_raw=str(t["gross"]))
    except (ValueError, KeyError):
        ann.update(net="?", vat="?", gross="?", gross_raw="0")
    doc["_"] = ann
    return doc


def compose_draft(store, draft, clients=None, settings=None):
    clients = clients if clients is not None else store.clients()
    client = clients.get(draft.get("client"))
    if client is None:
        raise ApiError(400, f"unknown client: {draft.get('client')!r}")
    return model.compose(draft, client, settings or store.settings())


def draft_info(store, draft, clients, settings):
    composed = compose_draft(store, draft, clients, settings)
    annotate(draft, composed)
    draft["_"]["problems"] = model.validate(composed)
    client = clients[draft["client"]]
    if draft.get("number"):
        draft["_"]["next_number"] = draft["number"]
    else:
        year = (draft.get("issue_date") or dt.date.today().isoformat())[:4]
        draft["_"]["next_number"] = store.format_number(
            client, store.next_seq(client["id"]), year)
    return draft


@route("GET", "/api/state")
def api_state(app, _body):
    store = app.store
    settings = store.settings()
    clients = store.clients()
    drafts = []
    for d in store.drafts():
        try:
            drafts.append(draft_info(store, d, clients, settings))
        except ApiError:
            drafts.append(annotate(d))
    return {
        "today": dt.date.today().isoformat(),
        "settings": settings,
        "clients": clients,
        "invoices": [annotate(i) for i in store.invoices()],
        "drafts": drafts,
        "problems": store.problems(),
        "meta": {
            "units": model.UNITS,
            "tax_schemes": model.TAX_SCHEMES,
        },
    }


@route("GET", r"/api/invoices/([^/]+)/pdf")
def api_invoice_pdf(app, _body, inv_id):
    inv = app.store.invoice(inv_id)
    path = app.store.invoice_path(inv, ".pdf")
    if not path.exists():
        raise ApiError(404, "no archived PDF for this invoice")
    return Pdf(path.read_bytes())


class Handler(BaseHTTPRequestHandler):
    server_version = "invoicer"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        self.send(status, json.dumps(obj, ensure_ascii=False).encode(),
                  "application/json")

    def dispatch(self, method):
        app = self.server
        if self.headers.get("Host") not in app.allowed_hosts:
            return self.send(403, b"forbidden", "text/plain")
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return self.static(method, url.path)

        token = self.headers.get("X-Token") or parse_qs(url.query).get("t", [""])[0]
        if not secrets.compare_digest(token, app.token):
            return self.send(403, b"bad token", "text/plain")

        for m, pattern, fn in ROUTES:
            match = pattern.match(url.path)
            if m == method and match:
                break
        else:
            return self.send_json(404, {"error": "not found"})

        try:
            body = None
            if method in ("POST", "PUT"):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"null")
            result = fn(app, body, *match.groups())
        except ApiError as e:
            return self.send_json(e.status, {"error": str(e), "problems": e.problems})
        except StoreError as e:
            return self.send_json(404, {"error": str(e)})
        except render.RenderError as e:
            return self.send_json(500, {"error": f"Rendering failed: {e}"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})

        if isinstance(result, Pdf):
            return self.send(200, bytes(result), "application/pdf")
        return self.send_json(200, result)

    def static(self, method, path):
        if method != "GET":
            return self.send(405, b"method not allowed", "text/plain")
        if path == "/":
            html = (STATIC / "index.html").read_text()
            body = html.replace("{{TOKEN}}", self.server.token).encode()
            return self.send(200, body, CONTENT_TYPES[".html"],
                             {"Content-Security-Policy": CSP})
        if path == "/logo.svg":
            file = BASE / "templates" / "logo.svg"
        else:
            m = re.fullmatch(r"/static/([a-z0-9_-]+\.[a-z]+)", path)
            file = STATIC / m.group(1) if m else None
        if not file or not file.is_file() or file.suffix not in CONTENT_TYPES:
            return self.send(404, b"not found", "text/plain")
        return self.send(200, file.read_bytes(), CONTENT_TYPES[file.suffix])


class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store, port, verbose=False):
        super().__init__(("127.0.0.1", port), Handler)
        self.store = store
        self.verbose = verbose
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        port = self.server_address[1]
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.url = f"http://127.0.0.1:{port}/"
