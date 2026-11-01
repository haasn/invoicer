// Invoice template. All values arrive pre-formatted as JSON via
// `--input data=...`; this file only does layout.
#let d = json(bytes(sys.inputs.data))
#let s = d.sender
#let r = d.recipient

#let primary = rgb("#0e6990")
#let accent = rgb("#0883b2")
#let muted = rgb("#475269")
#let ink = rgb("#0f152a")
#let tint = rgb("#edf7f8")
#let hair = rgb("#b8dde0")

#let nonempty(..xs) = xs.pos().filter(x => x != none and x != "")
#let lines(xs) = xs.join(linebreak())
#let paras(ps) = for p in ps { par(lines(p)) }

#set document(title: "Invoice " + d.number, author: s.name)
#set text(font: "Inter", size: 9.5pt, fill: ink, lang: "en")
#set par(leading: 0.62em, spacing: 1.1em)
#show link: set text(fill: primary)
#show regex("https?://[^\s]+"): it => link(it.text, it)

#set page(
  paper: "a4",
  margin: (top: 18mm, bottom: 34mm, left: 22mm, right: 20mm),
  background: if d.draft {
    rotate(-35deg, text(size: 96pt, weight: 800, fill: luma(235))[DRAFT])
  },
  footer: context {
    set text(size: 7.5pt, fill: muted)
    line(length: 100%, stroke: 0.6pt + primary)
    v(-1mm)
    grid(
      columns: (1fr, 1fr, 1fr),
      column-gutter: 6mm,
      lines(nonempty(s.name, ..s.address)),
      lines(nonempty(
        s.email,
        s.website,
        if s.vat_id != "" { "VAT ID " + s.vat_id },
        if s.tax_number != "" { "Steuernummer " + s.tax_number },
      )),
      lines(nonempty(
        if s.iban != "" { "IBAN " + s.iban },
        if s.bic != "" { "BIC " + s.bic },
      )),
    )
    let pages = counter(page).final().first()
    if pages > 1 {
      align(right)[Page #counter(page).display() of #pages]
    }
  },
)

// Letterhead, styled like the website's header: Roboto at 1.3rem next to
// a 32px icon, 0.2rem apart.
#let icon = 15mm
#grid(
  columns: (auto, 1fr),
  column-gutter: icon * 3.2 / 32,
  align: horizon,
  image("logo.svg", height: icon),
  stack(
    spacing: 2.2mm,
    text(font: "Roboto", size: icon * 20.8 / 32, tracking: 0.25em, {
      box(text(fill: gradient.linear(primary, accent, angle: 45deg))[haas])
      // Typst drops the tracking where the style changes.
      h(0.25em)
      text(fill: muted)[n]
    }),
    text(size: 8.5pt, fill: muted, d.tagline),
  ),
)

#v(16mm)

// Address block and invoice metadata
#grid(
  columns: (1fr, 64mm),
  column-gutter: 8mm,
  [
    #text(size: 7pt, fill: muted, ((s.name,) + s.address).join(" · "))
    #v(1mm)
    #strong(r.name) \
    #lines(r.address)
    #if r.vat_id != "" [ \ VAT ID #r.vat_id]
  ],
  {
    set text(size: 9pt)
    let row(k, v) = (text(fill: muted, k), v)
    table(
      columns: (auto, 1fr),
      stroke: none,
      inset: (x: 0pt, y: 2.4pt),
      align: (left, right),
      ..row("Invoice no.", strong(d.number)),
      ..row("Invoice date", d.issue_date),
      ..if d.service_period != "" { row("Service period", d.service_period) },
      ..row("Due date", d.due_date),
    )
  },
)

#v(14mm)

#text(size: 17pt, weight: 600, fill: primary)[Invoice #d.number]
#if d.title != "" {
  v(-2.5mm)
  text(size: 11pt, fill: muted, d.title)
}
#v(2mm)

#paras(d.intro)

// Line items
#{
  let head = if d.show_qty {
    ("Pos.", "Description", "Quantity", "Unit price", "Amount")
  } else {
    ("Pos.", "Description", "Amount")
  }
  let rows = d.items.enumerate().map(((i, it)) => {
    let row = (str(i + 1), it.desc)
    if d.show_qty { row += (it.qty, it.price) }
    row + (it.amount,)
  })
  table(
    columns: if d.show_qty { (auto, 1fr, auto, auto, auto) } else { (auto, 1fr, auto) },
    stroke: (_, y) => if y > 0 { (bottom: 0.5pt + hair) },
    fill: (_, y) => if y == 0 { tint },
    inset: (x: 6pt, y: 6.5pt),
    align: (x, _) => if x <= 1 { left } else { right },
    table.header(..head.map(h => text(size: 8.5pt, weight: 600, fill: primary, h))),
    ..rows.flatten(),
  )
}

#v(-1mm)
#align(right, table(
  columns: (auto, 34mm),
  stroke: none,
  inset: (x: 6pt, y: 4pt),
  align: right,
  [Net amount], d.net,
  [VAT #(d.rate)%], d.vat,
  table.hline(stroke: 0.8pt + primary),
  text(weight: 700)[Total (#d.currency)],
  text(weight: 700, fill: primary, d.gross),
))

#if d.tax_note != "" {
  block(
    width: 100%,
    fill: tint,
    inset: (x: 8pt, y: 7pt),
    radius: 2pt,
    text(size: 8.5pt, d.tax_note),
  )
}

#v(2mm)
Please transfer #d.currency #d.gross by *#d.due_date* to the account below,
quoting invoice number #d.number.

#paras(d.outro)
