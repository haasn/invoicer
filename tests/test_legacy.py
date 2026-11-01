import unittest

from invoicer import legacy

TEX = r"""
\documentclass{letter}
\address{Jane Doe \\ Street 1 \\ 12345 Town\\ jane@example.com \\ DE123456789 \\ IBAN DE00 1234 \\ SWIFT ABCDEFXX }
\addtocounter{duedatenum}{30} % payment term
\begin{document}
  \begin{letter}{ACME SAS \\ 1 rue X \\ 75000 Paris \\ FR00123456789}
    \opening{Invoice no. 7.\footnote{VAT to be paid by the recipient.} Due by \textbf{\thedateyear}.}

    This concerns ``Milestone 2'', see: \\
    https://example.com/pr/1
    \begin{invoice}{Euro}{0.0}
      \ProjectTitle{Consulting}%
      \Fee{Design \texttt{SWS\_OP} \& 100\% tests} {500.00} {2.5}
      \Fee{Umsatzsteuer 0\%\footnote{Intra-europe}} {0.00} {1}
    \end{invoice}
    \closing{See attached GPG signature}
  \end{letter}
\end{document}
"""


class ParseTest(unittest.TestCase):
    def test_parse(self):
        inv = legacy.parse(TEX)
        self.assertEqual(inv["number"], "7")
        self.assertEqual(inv["sender"], {
            "name": "Jane Doe", "address": ["Street 1", "12345 Town"],
            "email": "jane@example.com", "vat_id": "DE123456789",
            "iban": "DE00 1234", "bic": "ABCDEFXX"})
        self.assertEqual(inv["recipient"], {
            "name": "ACME SAS", "address": ["1 rue X", "75000 Paris"],
            "country": "FR", "vat_id": "FR00123456789"})
        self.assertEqual(inv["tax_note"], "VAT to be paid by the recipient.")
        self.assertEqual(inv["intro"],
                         "This concerns “Milestone 2”, see:\nhttps://example.com/pr/1")
        self.assertEqual(inv["items"], [{"desc": "Design SWS_OP & 100% tests",
                                         "qty": "2.5", "unit": "C62", "price": "500.00"}])
        self.assertEqual((inv["title"], inv["currency"], inv["rate"], inv["due_days"]),
                         ("Consulting", "EUR", "0", 30))
        self.assertEqual(inv["outro"], "See attached GPG signature")


if __name__ == "__main__":
    unittest.main()
