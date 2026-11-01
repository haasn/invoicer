"""PDF rendering via the Typst CLI."""

import calendar
import datetime as dt
import json
import subprocess
import tempfile
from pathlib import Path

from . import model

TEMPLATE = Path(__file__).resolve().parent.parent / "templates" / "invoice.typ"


class RenderError(Exception):
    pass


def fmt_period(period):
    start = model.parse_date(period["from"])
    end = model.parse_date(period["to"])
    last_day = calendar.monthrange(end.year, end.month)[1]
    if (start.day == 1 and end.day == last_day
            and (start.year, start.month) == (end.year, end.month)):
        return start.strftime("%B %Y")
    if start == end:
        return start.isoformat()
    return f"{start.isoformat()} – {end.isoformat()}"


def paragraphs(text):
    """Split free text into paragraphs (blank-line separated) of lines."""
    paras = [p.strip() for p in (text or "").replace("\r", "").split("\n\n")]
    return [p.split("\n") for p in paras if p]


def render_data(inv, settings):
    t = model.totals(inv)
    items = []
    for item in inv.get("items", []):
        qty = model.dec(item.get("qty", 1))
        unit = item.get("unit", "C62")
        items.append({
            "desc": item.get("desc", ""),
            "qty": model.qty_label(qty, unit),
            "price": model.fmt_money(model.dec(item.get("price", 0))),
            "amount": model.fmt_money(model.line_amount(item)),
            "simple": qty == 1 and unit == "C62",
        })
    draft = inv.get("status", "draft") == "draft" and not inv.get("number")
    try:
        period = fmt_period(inv["service_period"])
    except (KeyError, TypeError, ValueError):
        period = ""
    return {
        "draft": draft,
        "number": inv.get("number") or "DRAFT",
        "issue_date": inv.get("issue_date", ""),
        "due_date": inv.get("due_date", ""),
        "service_period": period,
        "title": inv.get("title", ""),
        "intro": paragraphs(inv.get("intro")),
        "outro": paragraphs(inv.get("outro")),
        "items": items,
        "show_qty": not all(i["simple"] for i in items),
        "currency": inv.get("currency", "EUR"),
        "rate": model.fmt_qty(model.dec(inv["tax"]["rate"])),
        "tax_note": inv["tax"].get("note", ""),
        "net": model.fmt_money(t["net"]),
        "vat": model.fmt_money(t["vat"]),
        "gross": model.fmt_money(t["gross"]),
        "sender": inv["sender"],
        "recipient": inv["recipient"],
        "tagline": settings.get("tagline", ""),
    }


def render_pdf(inv, settings, out_path):
    data = render_data(inv, settings)
    try:
        epoch = dt.datetime.fromisoformat(inv["issue_date"]).replace(
            hour=12, tzinfo=dt.timezone.utc).timestamp()
    except (KeyError, ValueError):
        epoch = None
    cmd = ["typst", "compile", "--root", str(TEMPLATE.parent),
           "--input", "data=" + json.dumps(data, ensure_ascii=False)]
    if epoch is not None:
        cmd += ["--creation-timestamp", str(int(epoch))]
    cmd += [str(TEMPLATE), str(out_path)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        raise RenderError("typst not found; please install it") from None
    if res.returncode != 0:
        raise RenderError(res.stderr.strip() or "typst failed")
    return out_path


def render_bytes(inv, settings):
    with tempfile.TemporaryDirectory(prefix="invoicer-") as tmp:
        out = Path(tmp) / "preview.pdf"
        render_pdf(inv, settings, out)
        return out.read_bytes()
