"""Local HTTP server for the browser UI.

Only binds to 127.0.0.1. Since any website can still send requests to
localhost, every request must carry the expected Host header (to defeat DNS
rebinding) and every API request a per-session token that is only embedded
in the served page.
"""

import datetime as dt
import json
import os
import re
import secrets
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from . import actions, gitsync, model, render, syncthing
from .store import HOST, RevisionConflict, StoreError

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
    def __init__(self, status, message, problems=None, **extra):
        super().__init__(message)
        self.status = status
        self.problems = problems or []
        self.extra = extra


class Pdf(bytes):
    def __new__(cls, data, filename=None):
        pdf = super().__new__(cls, data)
        pdf.filename = filename
        return pdf


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
        ann.update(net=money(t["net"]), vat=money(t["vat"]), gross=money(t["gross"]))
        # Exact integer amounts, so the UI can sum without float rounding.
        ann.update({f"{k}_cents": int(v * 100) for k, v in t.items()})
    except (ValueError, KeyError):
        ann.update(net="?", vat="?", gross="?", net_cents=0, vat_cents=0, gross_cents=0)
    doc["_"] = ann
    return doc


def annotate_invoice(store, inv):
    annotate(inv)
    inv["_"]["signed"] = store.invoice_path(inv, ".pdf.asc").exists()
    return inv


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
    with app.lock:
        resolved = store.resolve_conflicts()
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
        "invoices": [annotate_invoice(store, i) for i in store.invoices()],
        "drafts": drafts,
        "problems": store.problems(),
        "resolved": resolved,
        "git": app.git_status(),
        "meta": {
            "units": model.UNITS,
            "tax_schemes": model.TAX_SCHEMES,
        },
    }


@route("GET", "/api/sync-check")
def api_sync_check(app, _body):
    others = app.store.authors() - {HOST}
    return {"warnings": syncthing.issue_warnings(app.store.root, others)}


@route("GET", r"/api/invoices/([^/]+)/pdf")
def api_invoice_pdf(app, _body, inv_id):
    inv = app.store.invoice(inv_id)
    path = app.store.invoice_path(inv, ".pdf")
    if not path.exists():
        raise ApiError(404, "no archived PDF for this invoice")
    # The id rather than the number, which for imported invoices lacks the client code.
    return Pdf(path.read_bytes(), f"Invoice {inv_id}.pdf")


def clean_draft(body, existing=None):
    """Build a draft from user input, keeping only the editable fields."""
    if not isinstance(body, dict):
        raise ApiError(400, "expected a JSON object")
    existing = existing or {}
    draft = {"client": str(body.get("client", "")), "status": "draft"}
    for k in ("number", "seq"):
        if k in existing:
            draft[k] = existing[k]
    for k in ("issue_date", "due_date", "title", "intro", "outro"):
        draft[k] = str(body.get(k) or "")
    period = body.get("service_period") or {}
    draft["service_period"] = {"from": str(period.get("from") or ""),
                               "to": str(period.get("to") or "")}
    draft["items"] = [
        {"desc": str(i.get("desc", "")), "qty": str(i.get("qty", "1")),
         "unit": str(i.get("unit", "C62")), "price": str(i.get("price", "0"))}
        for i in body.get("items") or [] if isinstance(i, dict)
    ]
    return draft


@route("POST", "/api/drafts")
def api_new_draft(app, body):
    store = app.store
    client = store.client(body.get("client", ""))
    if body.get("from"):
        try:
            template = store.invoice(body["from"])
        except StoreError:
            template = store.draft(body["from"])
    else:
        prev = [i for i in store.invoices()
                if i.get("client") == client["id"] and i.get("status") != "cancelled"]
        template = prev[0] if prev else None
    draft = model.new_draft(client, store.settings(), dt.date.today(), template)
    with app.lock:
        store.save_draft(draft)
    return draft_info(store, draft, store.clients(), store.settings())


@route("POST", r"/api/drafts/([^/]+)/commit")
def api_commit_draft(app, _body, draft_id):
    draft = app.store.draft(draft_id)
    with app.lock:
        app.autocommit([app.store.draft_path(draft_id)],
                       f"Save draft for {client_label(app.store, draft)}")
    return {}


@route("PUT", r"/api/drafts/([^/]+)")
def api_save_draft(app, body, draft_id):
    store = app.store
    with app.lock:
        existing = store.draft(draft_id)
        store.check_revision(store.draft_path(draft_id), body.get("base_revision"))
        draft = clean_draft(body, existing)
        draft["id"] = draft_id
        compose_draft(store, draft)
        store.save_draft(draft)
    return draft_info(store, draft, store.clients(), store.settings())


@route("DELETE", r"/api/drafts/([^/]+)")
def api_delete_draft(app, _body, draft_id):
    label = client_label(app.store, app.store.draft(draft_id))
    with app.lock:
        path = app.store.delete_draft(draft_id)
        app.autocommit([path], f"Delete draft for {label}")
    return {}


@route("POST", "/api/preview")
def api_preview(app, body):
    draft = clean_draft(body)
    if body.get("number"):
        draft["number"] = str(body["number"])
    inv = compose_draft(app.store, draft)
    return Pdf(render.render_bytes(inv, app.store.settings()))


def client_label(store, doc):
    try:
        client = store.client(doc.get("client", ""))
        return client.get("short_name") or client.get("name", doc["client"])
    except StoreError:
        return doc.get("client", "?")


def run_action(app, fn, *args):
    with app.lock:
        try:
            doc, paths, message = fn(app.store, *args)
        except actions.ActionError as e:
            raise ApiError(422, str(e), e.problems) from None
        app.autocommit(paths, message)
    return annotate(doc)


@route("POST", r"/api/drafts/([^/]+)/issue")
def api_issue(app, _body, draft_id):
    return run_action(app, actions.issue, draft_id)


@route("POST", r"/api/invoices/([^/]+)/status")
def api_status(app, body, inv_id):
    return run_action(app, actions.set_status, inv_id, body.get("status"), body.get("paid_date"))


@route("POST", r"/api/invoices/([^/]+)/unlock")
def api_unlock(app, _body, inv_id):
    return run_action(app, actions.unlock, inv_id)


@route("POST", r"/api/invoices/([^/]+)/sign")
def api_sign(app, _body, inv_id):
    return run_action(app, actions.sign, inv_id)


@route("POST", r"/api/invoices/([^/]+)/reveal")
def api_reveal(app, _body, inv_id):
    path = app.store.invoice_path(app.store.invoice(inv_id), ".pdf")
    subprocess.Popen(["xdg-open", str(path.parent)], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return {}


CLIENT_FIELDS = {
    "name": str, "short_name": str, "code": str, "address": list, "country": str,
    "vat_id": str, "tax_scheme": str, "tax_note": str, "due_days": int, "currency": str,
    "title": str, "sender_email": str, "rate": str, "rate_unit": str,
    "buyer_reference": str, "emails": list, "archived": bool,
}
SENDER_FIELDS = {k: list if k == "address" else str for k in model.SENDER_FIELDS}
SETTINGS_FIELDS = {"tagline": str, "number_format": str, "due_days": int, "gpg_key": str}


def update_fields(existing, body, spec):
    """Overwrite the fields in `spec` from user input; drop empty ones."""
    out = dict(existing)
    for key, typ in spec.items():
        if key not in body:
            continue
        value = body[key]
        if typ is list:
            value = [str(v).strip() for v in value or [] if str(v).strip()]
        elif typ is int:
            value = int(value) if str(value).strip() else None
        elif typ is bool:
            value = bool(value)
        else:
            value = str(value or "").strip()
        if value in (None, "", [], False):
            out.pop(key, None)
        else:
            out[key] = value
    return out


@route("PUT", r"/api/clients/([^/]+)")
def api_save_client(app, body, client_id):
    store = app.store
    try:
        existing = store.client(client_id)
    except StoreError:
        existing = {}
    client = update_fields(existing, body, CLIENT_FIELDS)
    client.pop("id", None)
    if not client.get("name"):
        raise ApiError(400, "Client name is required")
    if not re.fullmatch(r"[A-Za-z0-9]+", client.get("code", "")):
        raise ApiError(400, "Client code must be alphanumeric, e.g. ACME")
    if client.get("tax_scheme", "eu_reverse_charge") not in model.TAX_SCHEMES:
        raise ApiError(400, "Unknown tax scheme")
    if client.get("rate_unit", "C62") not in model.UNITS:
        raise ApiError(400, "Unknown unit")
    client["id"] = client_id
    with app.lock:
        store.check_revision(store.client_path(client_id), body.get("base_revision"))
        path = store.save_client(client)
        app.autocommit([path], f"{'Update' if existing else 'Add'} client {client['name']}")
    return client


@route("PUT", "/api/settings")
def api_save_settings(app, body):
    store = app.store
    settings = store.settings()
    settings["sender"] = update_fields(settings["sender"], body.get("sender") or {}, SENDER_FIELDS)
    settings = update_fields(settings, body, SETTINGS_FIELDS)
    if "auto_commit" in body:
        settings["auto_commit"] = bool(body["auto_commit"])
    try:
        settings.get("number_format", "").format(code="X", year=2000, seq=1)
    except (KeyError, IndexError, ValueError) as e:
        raise ApiError(400, f"Invalid number format: {e}") from None
    with app.lock:
        store.check_revision(store.settings_path, body.get("base_revision"))
        app.autocommit([store.save_settings(settings)], "Update settings")
    return store.settings()


@route("POST", "/api/sync")
def api_sync(app, _body):
    with app.lock:
        try:
            output = gitsync.sync(app.store.root)
        except gitsync.GitError as e:
            raise ApiError(500, f"Sync failed: {e}") from None
    return {"output": output}


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
            return self.send_json(e.status, {"error": str(e), "problems": e.problems, **e.extra})
        except RevisionConflict as e:
            return self.send_json(409, {"error": str(e), "deleted": e.current is None,
                                        "changed_by": e.revision.get("host"),
                                        "changed_at": e.revision.get("time"),
                                        "current_revision": e.revision.get("id")})
        except StoreError as e:
            return self.send_json(404, {"error": str(e)})
        except render.RenderError as e:
            return self.send_json(500, {"error": f"Rendering failed: {e}"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})

        if isinstance(result, Pdf):
            # Suggests the file name when saving from the browser's PDF viewer.
            extra = {"Content-Disposition": f"inline; filename*=UTF-8''{quote(result.filename)}"
                     } if result.filename else None
            return self.send(200, bytes(result), "application/pdf", extra)
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


def load_token(path):
    """Read the API token from `path`, creating it if needed.

    Keeping the token across restarts means open browser tabs keep working.
    """
    try:
        token = path.read_text().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(24)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store, port, verbose=False, token_file=None):
        super().__init__(("127.0.0.1", port), Handler)
        self.store = store
        self.verbose = verbose
        self.token = load_token(Path(token_file)) if token_file else secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        port = self.server_address[1]
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.url = f"http://127.0.0.1:{port}/"
        self.git_error = None

    def autocommit(self, paths, message):
        """Commit `paths` if enabled; failures are reported via git_status()."""
        root = self.store.root
        if not self.store.settings().get("auto_commit") or not gitsync.is_repo(root):
            return
        try:
            gitsync.commit(root, paths, message)
            self.git_error = None
        except gitsync.GitError as e:
            self.git_error = f"Commit failed: {e}"

    def git_status(self):
        if not gitsync.is_repo(self.store.root):
            return None
        try:
            st = gitsync.status(self.store.root)
        except gitsync.GitError as e:
            st = {"error": str(e)}
        st["error"] = self.git_error or st.get("error")
        st["auto_commit"] = bool(self.store.settings().get("auto_commit"))
        return st
