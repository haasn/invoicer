"""Filesystem-backed storage: one JSON file per client, invoice and draft."""

import copy
import json
import os
import re
import uuid
from pathlib import Path

DEFAULT_SETTINGS = {
    "sender": {
        "name": "",
        "address": [],
        "email": "",
        "website": "",
        "vat_id": "",
        "tax_number": "",
        "iban": "",
        "bic": "",
    },
    "tagline": "",
    "number_format": "{code}-{year}-{seq:03}",
    "due_days": 21,
    "auto_commit": True,
}

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CONFLICT_RE = re.compile(r"\.sync-conflict-|\.orig$|\.rej$")
# Syncthing inserts the marker before the last extension.
SYNC_CONFLICT_RE = re.compile(r"^(?P<base>.+)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+(?P<ext>\.[^.]*)?$")
# Fields of an issued invoice that may legitimately change after issuing.
MUTABLE_INVOICE_FIELDS = {"status", "paid_date", "revision"}


class StoreError(Exception):
    pass


def check_id(ident):
    if not isinstance(ident, str) or not ID_RE.match(ident):
        raise StoreError(f"invalid id: {ident!r}")
    return ident


def _merge(defaults, value):
    out = copy.deepcopy(defaults)
    for k, v in value.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.load_errors = []

    # Low-level helpers

    def _read(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def _write(self, path, obj):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
        return path

    def _load_dir(self, pattern):
        out = []
        for path in sorted(self.root.glob(pattern)):
            if CONFLICT_RE.search(path.name):
                continue    # reported by problems()
            try:
                out.append((path, self._read(path)))
            except (OSError, ValueError) as e:
                self.load_errors.append(f"{path.relative_to(self.root)}: {e}")
        return out

    # Settings

    @property
    def settings_path(self):
        return self.root / "settings.json"

    def settings(self):
        if not self.settings_path.exists():
            return copy.deepcopy(DEFAULT_SETTINGS)
        return _merge(DEFAULT_SETTINGS, self._read(self.settings_path))

    def save_settings(self, settings):
        return self._write(self.settings_path, settings)

    # Clients

    def client_path(self, client_id):
        return self.root / "clients" / f"{check_id(client_id)}.json"

    def clients(self):
        out = {}
        for path, c in self._load_dir("clients/*.json"):
            c["id"] = path.stem
            out[path.stem] = c
        def display_name(c):
            return (c.get("short_name") or c.get("name", "")).lower()
        return dict(sorted(out.items(), key=lambda kv: display_name(kv[1])))

    def client(self, client_id):
        path = self.client_path(client_id)
        if not path.exists():
            raise StoreError(f"no such client: {client_id}")
        c = self._read(path)
        c["id"] = client_id
        return c

    def save_client(self, client):
        data = {k: v for k, v in client.items() if k != "id"}
        return self._write(self.client_path(client["id"]), data)

    # Issued invoices: invoices/<year>/<id>.json

    def invoice_path(self, inv, suffix=".json"):
        year = inv["issue_date"][:4]
        return self.root / "invoices" / year / f"{check_id(inv['id'])}{suffix}"

    def invoices(self):
        out = []
        for path, inv in self._load_dir("invoices/*/*.json"):
            inv["id"] = path.stem
            out.append(inv)
        out.sort(key=lambda i: (i.get("issue_date", ""), i["id"]), reverse=True)
        return out

    def invoice(self, inv_id):
        matches = sorted(self.root.glob(f"invoices/*/{check_id(inv_id)}.json"))
        if not matches:
            raise StoreError(f"no such invoice: {inv_id}")
        inv = self._read(matches[-1])
        inv["id"] = inv_id
        return inv

    def save_invoice(self, inv):
        return self._write(self.invoice_path(inv), inv)

    # Drafts: drafts/<id>.json

    def draft_path(self, draft_id):
        return self.root / "drafts" / f"{check_id(draft_id)}.json"

    def drafts(self):
        out = []
        for path, d in self._load_dir("drafts/*.json"):
            d["id"] = path.stem
            out.append(d)
        return out

    def draft(self, draft_id):
        path = self.draft_path(draft_id)
        if not path.exists():
            raise StoreError(f"no such draft: {draft_id}")
        d = self._read(path)
        d["id"] = draft_id
        return d

    def save_draft(self, draft):
        if not draft.get("id"):
            draft["id"] = uuid.uuid4().hex[:12]
        return self._write(self.draft_path(draft["id"]), draft)

    def delete_draft(self, draft_id):
        path = self.draft_path(draft_id)
        path.unlink(missing_ok=True)
        return path

    # Numbering

    def next_seq(self, client_id):
        seqs = [d.get("seq") or 0 for d in self.invoices() + self.drafts()
                if d.get("client") == client_id]
        return max(seqs, default=0) + 1

    def format_number(self, client, seq, year):
        fmt = self.settings()["number_format"]
        return fmt.format(code=client.get("code") or client["id"].upper(),
                          year=year, seq=seq)

    def _same_invoice(self, a, b):
        """Whether two versions of an invoice file describe the same invoice."""
        if a.suffix == ".asc":
            return True
        if a.suffix != ".json":
            return a.read_bytes() == b.read_bytes()
        try:
            x, y = self._read(a), self._read(b)
        except (OSError, ValueError):
            return False
        strip = lambda d: {k: v for k, v in d.items() if k not in MUTABLE_INVOICE_FIELDS}
        return strip(x) == strip(y)

    def resolve_conflicts(self):
        """Resolve syncthing conflict copies; returns a note per resolution.

        Syncthing keeps the newer version under the original name, so the
        newest edit wins by deleting the copy. Copies of issued invoices are
        kept if they differ in more than their payment status: that means the
        same number was issued twice, which needs a human.
        """
        notes = []
        for path in sorted(self.root.rglob("*.sync-conflict-*")):
            m = SYNC_CONFLICT_RE.match(path.name)
            if not m or not path.is_file():
                continue
            original = path.with_name(m["base"] + (m["ext"] or ""))
            rel = original.relative_to(self.root)
            if not original.exists():
                os.replace(path, original)
                notes.append(f"Restored {rel} from a sync conflict copy")
                continue
            if rel.parts[0] == "invoices" and not self._same_invoice(original, path):
                continue
            path.unlink()
            notes.append(f"Sync conflict in {rel} resolved: kept the newer version")
        return notes

    def problems(self):
        """Inconsistencies that can arise from syncing between machines."""
        self.load_errors = []
        docs = self.invoices() + self.drafts()
        out = list(self.load_errors)
        seen = {}
        for d in docs:
            key = (d.get("client"), d.get("number"))
            if key[1] and key in seen:
                out.append(f"Duplicate invoice number {key[1]} "
                           f"({seen[key]} and {d['id']})")
            seen.setdefault(key, d["id"])
        for path in self.root.rglob("*"):
            if ".git" in path.parts or not CONFLICT_RE.search(path.name):
                continue
            rel = path.relative_to(self.root)
            m = SYNC_CONFLICT_RE.match(path.name)
            if rel.parts[0] == "invoices" and m:
                out.append(f"Two different versions of {rel.parent / (m['base'] + (m['ext'] or ''))} "
                           f"exist; was the same invoice number issued on two machines? "
                           f"The other version is {rel}")
            else:
                out.append(f"Conflict file: {rel}")
        return out
