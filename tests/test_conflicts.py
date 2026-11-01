import json
import tempfile
import unittest
from pathlib import Path

from invoicer.store import Store

INV = {"id": "A-1", "number": "A-1", "client": "a", "issue_date": "2026-01-02",
       "status": "open", "items": [{"desc": "x", "qty": "1", "price": "1"}]}
COPY = ".sync-conflict-20261101-120000-ABCDEFG"


class ConflictTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, obj):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj))
        return path

    def test_newest_wins(self):
        self.write("drafts/d1.json", {"title": "newer"})
        copy = self.write(f"drafts/d1{COPY}.json", {"title": "older"})
        self.write("invoices/2026/A-1.json", {**INV, "status": "paid"})
        inv_copy = self.write(f"invoices/2026/A-1{COPY}.json", INV)
        self.assertEqual(len(self.store.resolve_conflicts()), 2)
        self.assertFalse(copy.exists() or inv_copy.exists())
        self.assertEqual(self.store.draft("d1")["title"], "newer")

    def test_different_invoices_kept(self):
        self.write("invoices/2026/A-1.json", INV)
        copy = self.write(f"invoices/2026/A-1{COPY}.json", {**INV, "client": "b"})
        self.assertEqual(self.store.resolve_conflicts(), [])
        self.assertTrue(copy.exists())
        self.assertEqual(len(self.store.invoices()), 1)
        self.assertIn("A-1.json", self.store.problems()[0])

    def test_restore_missing_original(self):
        self.write(f"clients/a{COPY}.json", {"name": "A"})
        self.store.resolve_conflicts()
        self.assertEqual(self.store.client("a")["name"], "A")


if __name__ == "__main__":
    unittest.main()
