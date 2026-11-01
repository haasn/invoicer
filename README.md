# invoicer

A small local invoicing tool: a browser UI served on `127.0.0.1`, plain JSON
files as the database, and [Typst](https://typst.app) for PDFs. It needs
Python 3.11+ (stdlib only), `typst`, and optionally `git` and `gpg`.

```sh
bin/invoicer --data ~/dev/invoice-data        # or set data_dir in ~/.config/invoicer/config.json
```

To keep it running in the background on port 8765, install
`contrib/invoicer.service` as a systemd user service (see the comment inside)
and bookmark http://127.0.0.1:8765/.

## Data directory

```
settings.json                     sender details, number format, defaults
clients/<id>.json                 one file per client
drafts/<id>.json                  unnumbered drafts
invoices/<year>/<number>.json     issued invoices (sender/recipient frozen at issue)
invoices/<year>/<number>.pdf      archived PDF, never re-rendered
invoices/<year>/<number>.pdf.asc  optional detached GPG signature
```

If the directory is a git repository, every change is committed automatically;
the Sync button runs `git pull --rebase` and `git push`. Add `*.pdf binary` to
its `.gitattributes`.

Issuing an invoice assigns the next number from `number_format`
(default `{code}-{year}-{seq:03}`, with a per-client sequence) and refuses
invoices that lack data required by §14 UStG, e.g. the service period or the
recipient's VAT ID for reverse-charge invoices.

## Importing the old LaTeX invoices

```sh
bin/invoicer --data DIR import-git ~/dev/invoice \
    --client FFLabs=fflabs:FFL --client "Software in the Public=spi:SPI" ...
```

Each `--client PATTERN=ID:CODE` maps recipients whose name contains `PATTERN`.

## Tests

```sh
python3 -m unittest
```
