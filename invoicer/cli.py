"""Command-line entry point."""

import argparse
import json
import sys
from pathlib import Path

from . import model, render
from .store import Store, StoreError

CONFIG = Path("~/.config/invoicer/config.json").expanduser()


def data_dir(args):
    if args.data:
        return args.data
    try:
        return json.loads(CONFIG.read_text())["data_dir"]
    except (OSError, ValueError, KeyError):
        sys.exit(f"No data directory: pass --data or set data_dir in {CONFIG}")


def load_doc(store, doc_id):
    """Return a fully composed invoice or draft."""
    try:
        return store.invoice(doc_id)
    except StoreError:
        draft = store.draft(doc_id)
        return model.compose(draft, store.client(draft["client"]), store.settings())


def cmd_render(store, args):
    inv = load_doc(store, args.id)
    out = Path(args.output or f"{args.id}.pdf")
    render.render_pdf(inv, store.settings(), out)
    print(out)


def main(argv=None):
    p = argparse.ArgumentParser(prog="invoicer")
    p.add_argument("--data", help="data directory (default: from config)")
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser("render", help="render an invoice or draft to PDF")
    r.add_argument("id")
    r.add_argument("-o", "--output")

    args = p.parse_args(argv)
    if not args.cmd:
        p.print_help()
        return 1
    store = Store(data_dir(args))
    try:
        {"render": cmd_render}[args.cmd](store, args)
    except (StoreError, render.RenderError, ValueError) as e:
        sys.exit(f"error: {e}")
    return 0
