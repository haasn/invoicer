# invoicer

A small local invoicing tool: a browser UI served on `127.0.0.1`, plain JSON
files as the database, and [Typst](https://typst.app) for PDFs. It needs
Python 3.11+ (stdlib only), `typst`, and optionally `git` and `gpg`.

```sh
bin/invoicer --data ~/sync/invoice        # or set data_dir in ~/.config/invoicer/config.json
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

## Using it on several machines

Put the data directory in a folder synced by [Syncthing](https://syncthing.net)
(without a `.git` inside). Every file carries a revision stamp, so:

- a tab that is open while the file changes on another machine reloads when it
  regains focus, or asks before overwriting if it has unsaved edits;
- when both machines changed the same file while disconnected, the newest edit
  wins (Syncthing's conflict copy is deleted), except for two different
  invoices issued under the same number, which is reported instead;
- before issuing, the tool asks the local Syncthing whether the folder is up to
  date and whether the other machines that edit invoices are connected.

Enable Syncthing's file versioning on at least one device for history.

Alternatively, if the directory is a git repository, every change is committed
automatically and the Sync button runs `git pull --rebase` and `git push`.

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
