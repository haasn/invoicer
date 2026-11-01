"""Ask the local syncthing whether the data directory is in sync.

Used before issuing an invoice: if another machine that also edits the
invoice data is offline, it may have issued invoices (and thus used
numbers) that have not arrived here yet.
"""

import datetime as dt
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CONFIGS = ("~/.local/state/syncthing/config.xml", "~/.config/syncthing/config.xml")


def _load_config():
    for path in CONFIGS:
        path = Path(path).expanduser()
        if path.exists():
            return ET.parse(path).getroot()
    return None


def _folder_for(root, config):
    """The syncthing folder containing `root` (deepest match), or None."""
    best = None
    for folder in config.findall("folder"):
        path = Path(folder.get("path", "")).expanduser().resolve()
        if root == path or path in root.parents:
            if best is None or len(path.parts) > len(best[0].parts):
                best = (path, folder)
    return best[1] if best else None


class Api:
    def __init__(self, gui):
        address = gui.findtext("address", "127.0.0.1:8384")
        if address.startswith(("0.0.0.0:", "[::]:")):
            address = "127.0.0.1:" + address.rsplit(":", 1)[1]
        tls = gui.get("tls") == "true"
        self.base = f"{'https' if tls else 'http'}://{address}"
        self.key = gui.findtext("apikey", "")
        # Syncthing's GUI certificate is self-signed; this only talks to localhost.
        self.ctx = ssl._create_unverified_context() if tls else None

    def get(self, path):
        req = urllib.request.Request(self.base + path, headers={"X-API-Key": self.key})
        with urllib.request.urlopen(req, timeout=3, context=self.ctx) as res:
            return json.load(res)


def _ago(stamp):
    try:
        when = dt.datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return "unknown"
    days = (dt.datetime.now(when.tzinfo) - when).days
    return f"{when:%Y-%m-%d %H:%M}" + (f", {days} days ago" if days > 1 else "")


def issue_warnings(root, authors):
    """Reasons why invoices from other machines might be missing here.

    `authors` are the host names that have written invoice data; other
    syncthing devices (phones, servers) are not expected to issue invoices.
    """
    try:
        config = _load_config()
    except (OSError, ET.ParseError):
        config = None
    folder = _folder_for(Path(root).resolve(), config) if config is not None else None
    if folder is None:
        return []

    names = {d.get("id"): d.get("name") or d.get("id")[:7] for d in config.findall("device")}
    try:
        api = Api(config.find("gui"))
        me = api.get("/rest/system/status")["myID"]
        status = api.get(f"/rest/db/status?folder={urllib.parse.quote(folder.get('id'))}")
        connections = api.get("/rest/system/connections")["connections"]
        stats = api.get("/rest/stats/device")
    except (OSError, ValueError, KeyError, urllib.error.URLError) as e:
        return [f"Could not ask syncthing whether this folder is up to date ({e}), "
                f"so changes from your other machines may be missing."]

    warnings = []
    if status.get("needTotalItems") or status.get("state") not in ("idle", None):
        warnings.append(f"Syncthing is still syncing this folder "
                        f"({status.get('needTotalItems', 0)} item(s) to fetch).")
    authors = {a.lower() for a in authors}
    for device in folder.findall("device"):
        dev = device.get("id")
        name = names.get(dev, dev[:7])
        if dev == me or name.lower() not in authors:
            continue
        if not connections.get(dev, {}).get("connected"):
            seen = _ago(stats.get(dev, {}).get("lastSeen"))
            warnings.append(f"{name} is not connected (last seen {seen}); invoices issued "
                            f"there since then are not visible here.")
    return warnings
