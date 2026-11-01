import datetime as dt
import tempfile
import unittest
from decimal import Decimal

from invoicer import model
from invoicer.store import Store


class TotalsTest(unittest.TestCase):
    def test_totals(self):
        inv = {"items": [{"qty": "0.5", "price": "200.00"},
                         {"qty": "3", "price": "33.335"}],
               "tax": {"rate": "19"}}
        t = model.totals(inv)
        self.assertEqual(t["net"], Decimal("200.01"))
        self.assertEqual(t["vat"], Decimal("38.00"))
        self.assertEqual(t["gross"], Decimal("238.01"))

    def test_invalid_amount(self):
        inv = {"items": [{"desc": "x", "qty": "0,5", "price": "1"}]}
        self.assertTrue(any("quantity" in p for p in model.validate(inv)))

    def test_reverse_charge_needs_vat_id(self):
        client = {"id": "c", "name": "C", "address": ["Somewhere"],
                  "tax_scheme": "eu_reverse_charge"}
        settings = {"sender": {"name": "Me", "address": ["Here"],
                               "vat_id": "DE123456789", "iban": "DE00"}}
        draft = model.new_draft(client, settings, dt.date(2026, 3, 15))
        draft["items"] = [{"desc": "Work", "qty": "1", "unit": "C62", "price": "10"}]
        self.assertEqual(draft["service_period"],
                         {"from": "2026-02-01", "to": "2026-02-28"})
        inv = model.compose(draft, client, settings)
        self.assertEqual(model.validate(inv),
                         ["Reverse charge requires the recipient's VAT ID"])
        client["vat_id"] = "FR00000000000"
        self.assertEqual(model.validate(model.compose(draft, client, settings)), [])


class NumberingTest(unittest.TestCase):
    def test_next_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            client = {"id": "acme", "code": "ACM", "name": "Acme"}
            store.save_client(client)
            self.assertEqual(store.next_seq("acme"), 1)
            store.save_invoice({"id": "ACM-44", "client": "acme", "seq": 44,
                                "number": "44", "issue_date": "2025-09-30"})
            store.save_invoice({"id": "OTH-2026-100", "client": "other",
                                "seq": 100, "issue_date": "2026-01-01"})
            seq = store.next_seq("acme")
            self.assertEqual(store.format_number(client, seq, 2026), "ACM-2026-045")


if __name__ == "__main__":
    unittest.main()
