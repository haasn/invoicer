"""Import invoices from the old workflow: one `invoice.latex` (using the
`invoice` LaTeX package) per git commit."""

import datetime as dt
import os
import re
import shutil
import subprocess
import tempfile
from collections import namedtuple
from pathlib import Path

from . import model
from .store import StoreError

EU = {"AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "EL",
      "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE",
      "SI", "SK"}
COUNTRY_NAMES = {"United States": "US", "USA": "US", "France": "FR", "Sweden": "SE",
                 "Germany": "DE"}
VAT_ID_RE = re.compile(r"^[A-Z]{2}[0-9A-Z]{8,14}$")
TEX_FILE = "invoice.latex"

Mapping = namedtuple("Mapping", "pattern client code")


# LaTeX parsing

def strip_comments(tex):
    return re.sub(r"(?<!\\)%.*", "", tex)


def read_group(tex, i):
    """Return (content, end) of the brace group starting at or after `i`."""
    while tex[i].isspace():
        i += 1
    if tex[i] != "{":
        raise ValueError(f"expected '{{' at offset {i}")
    depth, j = 0, i
    while j < len(tex):
        c = tex[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return tex[i + 1:j], j + 1
        j += 1
    raise ValueError("unbalanced braces")


def commands(tex, name, nargs=1):
    """Yield (args, start, end) for every `\\name{..}...{..}` in `tex`."""
    for m in re.finditer(rf"\\{name}(?![A-Za-z])", tex):
        args, pos = [], m.end()
        for _ in range(nargs):
            arg, pos = read_group(tex, pos)
            args.append(arg)
        yield args, m.start(), pos


def command(tex, name, nargs=1):
    return next(commands(tex, name, nargs), ([None] * nargs, -1, -1))


def unlatex(text):
    """Convert a LaTeX snippet to plain text."""
    for _ in range(3):  # nested formatting commands
        text = re.sub(r"\\(?:textbf|texttt|textit|emph|url)\{([^{}]*)\}", r"\1", text)
    for a, b in (("``", "“"), ("''", "”"), ("---", "—"), ("--", "–"), ("~", " "),
                 (r"\&", "&"), (r"\%", "%"), (r"\#", "#"), (r"\_", "_"), (r"\$", "$")):
        text = text.replace(a, b)
    return text


def split_lines(tex):
    return [unlatex(line).strip() for line in re.split(r"\\\\", tex) if line.strip()]


def paragraphs(tex):
    """Convert LaTeX prose to paragraphs separated by blank lines."""
    out = []
    for para in re.split(r"\n\s*\n", tex):
        lines = [" ".join(part.split()) for part in re.split(r"\\\\", para)]
        text = unlatex("\n".join(line for line in lines if line))
        if text:
            out.append(text)
    return "\n\n".join(out)


def parse_sender(lines):
    sender = {"name": lines[0] if lines else "", "address": []}
    for line in lines[1:]:
        if "@" in line:
            sender["email"] = line
        elif re.fullmatch(r"DE\s?\d{9}", line):
            sender["vat_id"] = line.replace(" ", "")
        elif line.startswith("Steuernummer"):
            sender["tax_number"] = line.removeprefix("Steuernummer").strip()
        elif line.startswith("IBAN"):
            sender["iban"] = line.removeprefix("IBAN").strip()
        elif line.startswith(("SWIFT", "BIC")):
            sender["bic"] = line.split(None, 1)[1].strip()
        else:
            sender["address"].append(line)
    return sender


def parse_recipient(lines):
    r = {"name": lines[0] if lines else "", "address": [], "country": "", "vat_id": ""}
    for line in lines[1:]:
        if VAT_ID_RE.match(line):
            r["vat_id"] = line
        else:
            r["address"].append(line)
    if r["vat_id"]:
        r["country"] = r["vat_id"][:2]
    elif r["address"] and r["address"][-1] in COUNTRY_NAMES:
        r["country"] = COUNTRY_NAMES[r["address"][-1]]
    return r


def parse(tex):
    """Extract the invoice data from one `invoice.latex`."""
    tex = strip_comments(tex)
    inv = {"items": [], "tax_note": "", "intro": "", "outro": ""}

    (address,), _, _ = command(tex, "address")
    inv["sender"] = parse_sender(split_lines(address or ""))

    m = re.search(r"\\begin\{letter\}", tex)
    letter, _ = read_group(tex, m.end())
    inv["recipient"] = parse_recipient(split_lines(letter))

    (opening,), _, opening_end = command(tex, "opening")
    for (note,), _, _ in commands(opening, "footnote"):
        inv["tax_note"] = paragraphs(note)
    opening = re.sub(r"\\footnote\{[^{}]*\}", "", opening)
    m = re.search(r"Invoice\s+no\.?\s*#?(\d+)\.?", opening)
    inv["number"] = m.group(1) if m else None
    if m:
        opening = opening.replace(m.group(0), "")
    opening = re.sub(r"Due by \\textbf\{[^{}]*\}\.?", "", opening)

    begin = re.search(r"\\begin\{invoice\}\{([^{}]*)\}\{([^{}]*)\}", tex)
    inv["intro"] = paragraphs(opening + "\n\n" + tex[opening_end:begin.start()])
    inv["currency"] = {"Euro": "EUR"}.get(begin.group(1).strip(), begin.group(1).strip())
    inv["rate"] = model.fmt_qty(model.dec(begin.group(2)))

    end = tex.index(r"\end{invoice}")
    body = tex[begin.end():end]
    (title,), _, _ = command(body, "ProjectTitle")
    inv["title"] = unlatex(title or "").strip()
    for (desc, price, qty), _, _ in commands(body, "Fee", 3):
        desc = unlatex(re.sub(r"\\footnote\{[^{}]*\}", "", desc)).strip()
        if re.search(r"VAT|Umsatzsteuer", desc) and model.dec(price) == 0:
            continue
        inv["items"].append({"desc": " ".join(desc.split()), "qty": model.fmt_qty(model.dec(qty)),
                             "unit": "C62", "price": price.strip()})

    tail = tex[end + len(r"\end{invoice}"):tex.index(r"\end{letter}")]
    (closing,), cstart, _ = command(tail, "closing")
    post = paragraphs(tail[:cstart] if cstart >= 0 else tail)
    if "VAT" in post:
        inv["tax_note"] = post
    elif post:
        inv["outro"] = post
    if closing and closing.strip() != "Kind regards,":
        inv["outro"] = "\n\n".join(filter(None, [inv["outro"], unlatex(closing).strip()]))

    m = re.search(r"\\addtocounter\{duedatenum\}\{(\d+)\}", tex)
    inv["due_days"] = int(m.group(1)) if m else None
    return inv


# Import from git

def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                          text=True, check=True).stdout


def slug(text):
    return re.sub(r"[^A-Za-z0-9.]+", "-", text).strip("-").lower()


def rebuild_pdf(tex, date, out):
    """Re-run pdflatex with \\today pinned to the original date."""
    epoch = dt.datetime.combine(date, dt.time(12), dt.timezone.utc).timestamp()
    env = dict(os.environ, SOURCE_DATE_EPOCH=str(int(epoch)), FORCE_SOURCE_DATE="1")
    with tempfile.TemporaryDirectory(prefix="invoicer-legacy-") as tmp:
        (Path(tmp) / TEX_FILE).write_text(tex)
        res = subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", TEX_FILE],
                             cwd=tmp, env=env, capture_output=True, text=True, timeout=120)
        pdf = Path(tmp) / "invoice.pdf"
        if res.returncode != 0 or not pdf.exists():
            raise RuntimeError(res.stdout[-500:])
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf, out)


def import_git(store, repo, mappings, pdfs=True, log=print):
    """Import every version of invoice.latex in `repo`; returns the invoices."""
    found = {}
    revs = git(repo, "log", "--branches", "--remotes", "--reverse", "--format=%H %cs %s",
               "--", TEX_FILE)
    for line in revs.splitlines():
        commit, date, subject = line.split(" ", 2)
        tex = git(repo, "show", f"{commit}:{TEX_FILE}")
        try:
            data = parse(tex)
        except (ValueError, TypeError, AttributeError) as e:
            log(f"  skip {commit[:10]} ({subject}): cannot parse: {e}")
            continue
        name = data["recipient"]["name"]
        mapping = next((m for m in mappings if m.pattern.lower() in name.lower()), None)
        if not mapping:
            log(f"  skip {commit[:10]} ({subject}): no client for {name!r}")
            continue
        number = data["number"] or subject
        # Later commits with the same number (e.g. "Fix address") replace earlier ones.
        found[(mapping.client, number)] = (commit, date, subject, mapping, data, tex)

    invoices = []
    latest = {}
    for commit, date, subject, mapping, data, tex in found.values():
        num = data["number"]
        inv = {
            "id": f"{mapping.code}-{num}" if num else f"{mapping.code}-{slug(subject)}",
            "number": num or subject,
            "seq": int(num) if num else None,
            "client": mapping.client,
            "status": "paid",
            "issue_date": date,
            "due_date": model.add_days(date, data["due_days"]) if data["due_days"] else None,
            "currency": data["currency"],
            "title": data["title"],
            "intro": data["intro"],
            "items": data["items"],
            "outro": data["outro"],
            "tax": {"scheme": tax_scheme(data["recipient"]["country"]),
                    "rate": data["rate"], "note": data["tax_note"]},
            "sender": {**{k: "" for k in model.SENDER_FIELDS}, **data["sender"]},
            "recipient": {**data["recipient"], "buyer_reference": ""},
            "legacy": {"commit": commit, "subject": subject},
        }
        inv["tax"]["category"] = model.TAX_SCHEMES[inv["tax"]["scheme"]]["category"]
        inv = {k: v for k, v in inv.items() if v is not None}
        invoices.append((inv, tex))
        if inv["issue_date"] >= latest.get(mapping.client, ("",))[0]:
            latest[mapping.client] = (inv["issue_date"], inv, mapping, data["due_days"])

    # Only the most recent invoice per client might still be unpaid.
    cutoff = (dt.date.today() - dt.timedelta(days=90)).isoformat()
    for _, inv, _, _ in latest.values():
        if inv["issue_date"] >= cutoff:
            inv["status"] = "open"

    for inv, tex in sorted(invoices, key=lambda x: x[0]["issue_date"]):
        try:
            store.invoice(inv["id"])
            log(f"  exists {inv['id']}")
            continue
        except StoreError:
            pass
        store.save_invoice(inv)
        total = model.fmt_money(model.totals(inv)["gross"])
        log(f"  {inv['issue_date']}  {inv['id']:<36} {total:>12} {inv['currency']}  {inv['status']}")
        if pdfs:
            try:
                rebuild_pdf(tex, model.parse_date(inv["issue_date"]),
                            store.invoice_path(inv, ".pdf"))
            except (RuntimeError, OSError, subprocess.SubprocessError) as e:
                log(f"    PDF rebuild failed: {e}")

    if not store.settings_path.exists() and latest:
        newest = max(latest.values(), key=lambda x: x[0])[1]
        settings = store.settings()
        settings["sender"].update(newest["sender"])
        store.save_settings(settings)
        log(f"  settings: sender details taken from {newest['id']}")
    my_email = store.settings()["sender"]["email"]

    for _, inv, mapping, due_days in latest.values():
        path = store.client_path(mapping.client)
        if path.exists():
            continue
        r = inv["recipient"]
        client = {
            "id": mapping.client, "code": mapping.code, "name": r["name"],
            "address": r["address"], "country": r["country"], "vat_id": r["vat_id"],
            "tax_scheme": inv["tax"]["scheme"], "currency": inv["currency"],
            "title": inv.get("title", ""), "due_days": due_days,
        }
        if inv["sender"].get("email") != my_email:
            client["sender_email"] = inv["sender"].get("email")
        store.save_client({k: v for k, v in client.items() if v})
        log(f"  client {mapping.client}: {r['name']}"
            + ("" if r["country"] else " (country unknown, please set it)"))
    return [inv for inv, _ in invoices]


def tax_scheme(country):
    # Unknown countries default to the common case of an EU business.
    return "non_eu" if country and country not in EU else "eu_reverse_charge"
