"""Command-line entry point."""

import argparse
import json
import sys
import webbrowser
from pathlib import Path

from . import legacy, model, render, server
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


def cmd_import_git(store, args):
    mappings = []
    for spec in args.client:
        try:
            pattern, rest = spec.split("=", 1)
            client, code = rest.split(":", 1)
        except ValueError:
            sys.exit(f"invalid --client {spec!r}, expected PATTERN=ID:CODE")
        mappings.append(legacy.Mapping(pattern, client, code))
    legacy.import_git(store, args.repo, mappings, pdfs=not args.no_pdf)


def cmd_serve(store, args):
    try:
        app = server.App(store, args.port, args.verbose)
    except OSError as e:
        sys.exit(f"Cannot listen on port {args.port}: {e} (already running?)")
    print(f"Serving {store.root} at {app.url}")
    if not args.no_browser:
        webbrowser.open(app.url)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    p = argparse.ArgumentParser(prog="invoicer")
    p.add_argument("--data", help="data directory (default: from config)")
    sub = p.add_subparsers(dest="cmd")

    sv = sub.add_parser("serve", help="run the web UI (default)")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--no-browser", action="store_true")
    sv.add_argument("-v", "--verbose", action="store_true")

    r = sub.add_parser("render", help="render an invoice or draft to PDF")
    r.add_argument("id")
    r.add_argument("-o", "--output")

    im = sub.add_parser("import-git", help="import invoices from the old LaTeX repository")
    im.add_argument("repo")
    im.add_argument("--client", action="append", required=True, metavar="PATTERN=ID:CODE",
                    help="map recipients whose name contains PATTERN to client ID "
                         "with number prefix CODE (repeatable)")
    im.add_argument("--no-pdf", action="store_true", help="do not rebuild PDFs")

    # Default to "serve", keeping global options in front of it.
    argv = sys.argv[1:] if argv is None else list(argv)
    i = 0
    while i < len(argv) and argv[i].startswith("--data"):
        i += 1 if "=" in argv[i] else 2
    if i >= len(argv) or argv[i] not in sub.choices and argv[i] not in ("-h", "--help"):
        argv.insert(i, "serve")
    args = p.parse_args(argv)
    store = Store(data_dir(args))
    try:
        commands = {"serve": cmd_serve, "render": cmd_render, "import-git": cmd_import_git}
        commands[args.cmd](store, args)
    except (StoreError, render.RenderError, ValueError) as e:
        sys.exit(f"error: {e}")
    return 0
