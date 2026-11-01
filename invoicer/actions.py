"""Invoice state transitions.

Each returns the resulting document, the paths it touched and a short
description of the change (used as commit message).
"""

import datetime as dt
import re
import subprocess

from . import model, render
from .store import StoreError, check_id

INVOICE_KEYS = ("id", "number", "seq", "client", "status", "issue_date", "due_date",
                "paid_date", "service_period", "currency", "title", "intro", "items",
                "outro", "tax", "sender", "recipient", "email_body", "legacy")
DRAFT_KEYS = ("client", "status", "number", "seq", "issue_date", "due_date",
              "service_period", "title", "intro", "items", "outro", "email_body")


class ActionError(Exception):
    def __init__(self, message, problems=None):
        super().__init__(message)
        self.problems = problems or []


def _ordered(doc, keys):
    out = {k: doc[k] for k in keys if doc.get(k) is not None}
    out.update((k, v) for k, v in doc.items() if k not in out and not k.startswith("_"))
    return out


def number_to_id(number):
    return check_id(re.sub(r"[^A-Za-z0-9._-]+", "-", number).strip("-"))


def issue(store, draft_id):
    draft = store.draft(draft_id)
    client = store.client(draft["client"])
    settings = store.settings()
    inv = model.compose(draft, client, settings)
    problems = model.validate(inv)
    if problems:
        raise ActionError("This draft cannot be issued yet", problems)

    if not inv.get("number"):
        inv["seq"] = store.next_seq(client["id"])
        inv["number"] = store.format_number(client, inv["seq"], inv["issue_date"][:4])
    inv["id"] = number_to_id(inv["number"])
    inv["status"] = "open"
    inv = _ordered(inv, INVOICE_KEYS)
    try:
        store.invoice(inv["id"])
        raise ActionError(f"Invoice {inv['id']} already exists")
    except StoreError:
        pass

    pdf = render.render_pdf(inv, settings, store.invoice_path(inv, ".pdf"))
    paths = [store.save_invoice(inv), pdf, store.delete_draft(draft_id)]
    return inv, paths, f"Issue {inv['number']}"


def set_status(store, inv_id, status, paid_date=None):
    inv = store.invoice(inv_id)
    if status not in ("open", "paid", "cancelled"):
        raise ActionError(f"Invalid status: {status}")
    inv["status"] = status
    inv.pop("paid_date", None)
    if status == "paid":
        inv["paid_date"] = model.parse_date(paid_date or dt.date.today().isoformat()).isoformat()
    inv = _ordered(inv, INVOICE_KEYS)
    path = store.save_invoice(inv)
    verb = {"open": "Mark {} unpaid", "paid": "Mark {} paid", "cancelled": "Cancel {}"}[status]
    return inv, [path], verb.format(inv["id"])


def unlock(store, inv_id):
    """Turn an issued invoice back into a draft, keeping its number."""
    inv = store.invoice(inv_id)
    draft = {k: inv[k] for k in DRAFT_KEYS if k in inv}
    draft["status"] = "draft"
    draft["id"] = inv_id
    paths = [store.save_draft(draft)]
    for suffix in (".json", ".pdf", ".pdf.asc"):
        path = store.invoice_path(inv, suffix)
        path.unlink(missing_ok=True)
        paths.append(path)
    return draft, paths, f"Unlock {inv['id']} for editing"


def sign(store, inv_id):
    """Create a detached ASCII-armored GPG signature next to the PDF."""
    inv = store.invoice(inv_id)
    pdf = store.invoice_path(inv, ".pdf")
    asc = store.invoice_path(inv, ".pdf.asc")
    if not pdf.exists():
        raise ActionError("This invoice has no archived PDF")
    cmd = ["gpg", "--yes", "--armor", "--detach-sign", "--output", str(asc)]
    key = store.settings().get("gpg_key")
    if key:
        cmd += ["--local-user", key]
    try:
        res = subprocess.run(cmd + [str(pdf)], capture_output=True, text=True,
                             stdin=subprocess.DEVNULL, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ActionError(f"Signing failed: {e}") from None
    if res.returncode != 0:
        raise ActionError(f"Signing failed: {res.stderr.strip()}")
    return inv, [asc], f"Sign {inv['id']}"
