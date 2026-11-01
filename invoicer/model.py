"""Invoice data model: money arithmetic, tax schemes, composition, validation."""

import datetime as dt
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CENT = Decimal("0.01")

# UN/ECE Recommendation 20 unit codes, as used by EN 16931:
# code -> (singular, plural) display label; empty means "no unit shown".
UNITS = {
    "C62": ("", ""),
    "HUR": ("hour", "hours"),
    "DAY": ("day", "days"),
}

TAX_SCHEMES = {
    "eu_reverse_charge": {
        "label": "EU business, reverse charge",
        "rate": "0",
        "category": "AE",
        "needs_vat_id": True,
        "note": "VAT to be paid by the recipient, per the reverse charge system "
                "for intra-European service exchanges "
                "(Steuerschuldnerschaft des Leistungsempfängers).",
    },
    "non_eu": {
        "label": "Outside the EU",
        "rate": "0",
        "category": "O",
        "needs_vat_id": False,
        "note": "This invoice does not include VAT. The recipient is required "
                "to pay VAT (reverse charge system).",
    },
    "domestic": {
        "label": "Germany",
        "rate": "19",
        "category": "S",
        "needs_vat_id": False,
        "note": "",
    },
}

STATUSES = ("draft", "open", "paid", "cancelled")

SENDER_FIELDS = ("name", "address", "email", "website",
                 "vat_id", "tax_number", "iban", "bic")


def dec(value, what="number"):
    try:
        d = Decimal(str(value).strip())
    except InvalidOperation:
        raise ValueError(f"invalid {what}: {value!r}") from None
    if not d.is_finite():
        raise ValueError(f"invalid {what}: {value!r}")
    return d


def fmt_money(d):
    return f"{d.quantize(CENT, ROUND_HALF_UP):,.2f}"


def fmt_qty(d):
    return format(d.normalize(), "f")


def qty_label(qty, unit):
    singular, plural = UNITS.get(unit, (unit, unit))
    label = singular if qty == 1 else plural
    return f"{fmt_qty(qty)} {label}".strip()


def line_amount(item):
    qty = dec(item.get("qty", 1), "quantity")
    price = dec(item.get("price", 0), "price")
    return (qty * price).quantize(CENT, ROUND_HALF_UP)


def totals(inv):
    net = sum((line_amount(i) for i in inv.get("items", [])), Decimal(0))
    rate = dec(inv.get("tax", {}).get("rate", 0), "VAT rate")
    vat = (net * rate / 100).quantize(CENT, ROUND_HALF_UP)
    return {"net": net, "vat": vat, "gross": net + vat}


def parse_date(s):
    return dt.date.fromisoformat(s)


def add_days(date_str, days):
    return (parse_date(date_str) + dt.timedelta(days=int(days))).isoformat()


def previous_month(today):
    last = today.replace(day=1) - dt.timedelta(days=1)
    return {"from": last.replace(day=1).isoformat(), "to": last.isoformat()}


def tax_for(client):
    key = client.get("tax_scheme") or "eu_reverse_charge"
    scheme = TAX_SCHEMES[key]
    return {
        "scheme": key,
        "rate": scheme["rate"],
        "category": scheme["category"],
        "note": client.get("tax_note") or scheme["note"],
    }


def sender_snapshot(settings, client):
    sender = settings.get("sender", {})
    snap = {k: sender.get(k, [] if k == "address" else "") for k in SENDER_FIELDS}
    if client.get("sender_email"):
        snap["email"] = client["sender_email"]
    return snap


def recipient_snapshot(client):
    return {
        "name": client.get("name", ""),
        "address": list(client.get("address", [])),
        "country": client.get("country", ""),
        "vat_id": client.get("vat_id", ""),
        "buyer_reference": client.get("buyer_reference", ""),
    }


def compose(doc, client, settings):
    """Fill in sender, recipient and tax details of a draft from its client."""
    inv = dict(doc)
    inv["sender"] = sender_snapshot(settings, client)
    inv["recipient"] = recipient_snapshot(client)
    inv["tax"] = tax_for(client)
    inv["currency"] = client.get("currency") or "EUR"
    return inv


def new_draft(client, settings, today, template=None):
    issue = today.isoformat()
    due_days = client.get("due_days") or settings.get("due_days", 21)
    draft = {
        "client": client["id"],
        "status": "draft",
        "issue_date": issue,
        "due_date": add_days(issue, due_days),
        "service_period": previous_month(today),
        "title": client.get("title", ""),
        "intro": "",
        "items": [],
        "outro": "",
    }
    if template:
        draft["title"] = template.get("title") or draft["title"]
        draft["items"] = [dict(i) for i in template.get("items", [])]
    return draft


def _check_date(problems, value, what):
    try:
        return parse_date(value)
    except (TypeError, ValueError):
        problems.append(f"{what} is missing or invalid")


def validate(inv):
    """Return a list of reasons why `inv` is not a valid invoice (§14 UStG)."""
    problems = []
    s, r, tax = inv.get("sender", {}), inv.get("recipient", {}), inv.get("tax", {})
    scheme = TAX_SCHEMES.get(tax.get("scheme"), {})

    if not s.get("name") or not s.get("address"):
        problems.append("Sender name and address are required (see Settings)")
    if scheme.get("needs_vat_id") and not s.get("vat_id"):
        problems.append("Reverse charge requires your own VAT ID (see Settings)")
    elif not s.get("vat_id") and not s.get("tax_number"):
        problems.append("Your VAT ID or tax number is required (see Settings)")
    if not s.get("iban"):
        problems.append("Sender IBAN is missing (see Settings)")
    if not r.get("name") or not r.get("address"):
        problems.append("Recipient name and address are required")
    if scheme.get("needs_vat_id") and not r.get("vat_id"):
        problems.append("Reverse charge requires the recipient's VAT ID")

    issue = _check_date(problems, inv.get("issue_date"), "Issue date")
    due = _check_date(problems, inv.get("due_date"), "Due date")
    if issue and due and due < issue:
        problems.append("Due date is before the issue date")
    period = inv.get("service_period") or {}
    start = _check_date(problems, period.get("from"), "Service period start")
    end = _check_date(problems, period.get("to"), "Service period end")
    if start and end and end < start:
        problems.append("Service period ends before it starts")

    items = inv.get("items", [])
    if not items:
        problems.append("At least one line item is required")
    for n, item in enumerate(items, 1):
        if not str(item.get("desc", "")).strip():
            problems.append(f"Item {n}: description is empty")
        try:
            line_amount(item)
        except ValueError as e:
            problems.append(f"Item {n}: {e}")
        if item.get("unit", "C62") not in UNITS:
            problems.append(f"Item {n}: unknown unit {item.get('unit')!r}")
    return problems


def display_status(inv, today):
    status = inv.get("status", "draft")
    if status == "open" and inv.get("due_date", "9999") < today.isoformat():
        return "overdue"
    return status
