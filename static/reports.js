"use strict";

// Reports: tax summaries and income statistics. Uses the helpers in app.js.

// Filter state, shared by all report views so switching keeps the slice.
const REPORT = { year: "all", gran: "quarter", basis: "issued", client: "", split: false, tables: {} };

const BASES = {
    issued: ["Invoice date",
             "Invoices count in the period of their invoice date (Soll-Versteuerung)."],
    service: ["Service period end",
              "Invoices count in the period in which the service was completed, e.g. for the "
              + "Zusammenfassende Meldung. Falls back to the invoice date if no service period was recorded."],
    paid: ["Payment date",
           "Only paid invoices count, in the period in which payment was received (Ist-Versteuerung, EÜR). "
           + "Falls back to the invoice date if no payment date was recorded."],
};
const GRANS = { month: "Month", quarter: "Quarter", year: "Year" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Data */

// Invoices relevant to the chosen basis, each with the date that assigns it to a period.
function reportRows(basis = REPORT.basis) {
    const rows = [];
    for (const inv of S.invoices) {
        if (inv.status === "cancelled") continue;
        let date = inv.issue_date, fallback = false;
        if (basis === "paid") {
            if (inv.status !== "paid") continue;
            date = inv.paid_date || inv.issue_date;
            fallback = !inv.paid_date;
        } else if (basis === "service") {
            const end = inv.service_period && inv.service_period.to;
            date = end || inv.issue_date;
            fallback = !end;
        }
        rows.push({ inv, date, fallback });
    }
    return rows;
}

function mainCurrency(rows) {
    const counts = {};
    for (const r of rows) counts[r.inv.currency || "EUR"] = (counts[r.inv.currency || "EUR"] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "EUR";
}

function periodKey(date, gran) {
    const y = date.slice(0, 4), m = Number(date.slice(5, 7));
    if (gran === "year") return y;
    if (gran === "quarter") return `${y}-Q${Math.ceil(m / 3)}`;
    return date.slice(0, 7);
}

function periodLabel(key, short = false) {
    let m = key.match(/^(\d{4})-Q(\d)$/);
    if (m) return short ? `Q${m[2]} ’${m[1].slice(2)}` : `Q${m[2]} ${m[1]}`;
    m = key.match(/^(\d{4})-(\d{2})$/);
    if (m) return short ? `${MONTHS[m[2] - 1]} ’${m[1].slice(2)}` : `${MONTHS[m[2] - 1]} ${m[1]}`;
    return key;
}

// All period keys between two ISO dates, inclusive.
function periodRange(gran, from, to) {
    const keys = [];
    let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    const end = to.slice(0, 7);
    for (;;) {
        const ym = `${y}-${String(m).padStart(2, "0")}`;
        if (ym > end) break;
        const key = periodKey(ym, gran);
        if (keys[keys.length - 1] !== key) keys.push(key);
        if (++m > 12) { m = 1; y++; }
    }
    return keys;
}

function reportYears(rows) {
    return [...new Set(rows.map(r => r.date.slice(0, 4)))].sort().reverse();
}

// The rows in the selected slice, plus the date bounds of that slice.
function reportSlice({ withClient = false } = {}) {
    const all = reportRows();
    const currency = mainCurrency(all);
    let rows = all.filter(r => (r.inv.currency || "EUR") === currency);
    const excluded = all.length - rows.length;
    const years = reportYears(rows);
    if (REPORT.year !== "all" && !years.includes(REPORT.year)) REPORT.year = "all";
    if (REPORT.year !== "all") rows = rows.filter(r => r.date.startsWith(REPORT.year));
    if (withClient && REPORT.client) rows = rows.filter(r => r.inv.client === REPORT.client);

    let from, to;
    if (REPORT.year !== "all") {
        from = `${REPORT.year}-01-01`;
        to = REPORT.year === S.today.slice(0, 4) ? S.today : `${REPORT.year}-12-31`;
    } else {
        const dates = rows.map(r => r.date).sort();
        from = dates[0] || S.today;
        to = S.today;
    }
    const last = rows.map(r => r.date).sort().pop();
    if (last && last > to) to = last;
    return { rows, currency, excluded, years, from, to };
}

function emptySums() {
    return { count: 0, net: 0, vat: 0, gross: 0, schemes: {} };
}

function addTo(sums, inv) {
    const scheme = (inv.tax && inv.tax.scheme) || "?";
    sums.count += 1;
    sums.net += inv._.net_cents;
    sums.vat += inv._.vat_cents;
    sums.gross += inv._.gross_cents;
    sums.schemes[scheme] = (sums.schemes[scheme] || 0) + inv._.net_cents;
}

function groupBy(rows, keyFn, keys = []) {
    const groups = new Map(keys.map(k => [k, emptySums()]));
    for (const r of rows) {
        const k = keyFn(r);
        if (!groups.has(k)) groups.set(k, emptySums());
        addTo(groups.get(k), r.inv);
    }
    return groups;
}

function amount(c) {
    return fmt.format(c / 100);
}

function schemeLabel(scheme) {
    const s = S.meta.tax_schemes[scheme];
    return s ? s.label : scheme;
}

/* Shared UI */

function reportFilters(opts = {}) {
    const { years } = reportSlice();
    const select = (key, options, onchange) => h("select", { onchange: e => {
        REPORT[key] = e.target.value;
        if (onchange) onchange();
        render();
    } }, options.map(([v, l]) => h("option", { value: v, selected: REPORT[key] === v }, l)));
    const field = (label, input) => h("label", { class: "filter" }, h("span", null, label), input);

    const items = [
        field("Year", select("year", [["all", "All years"], ...years.map(y => [y, y])])),
        field("Group by", select("gran", Object.entries(GRANS))),
    ];
    if (opts.clients) {
        items.push(field("Client", select("client", [["", "All clients"],
            ...Object.values(S.clients).map(c => [c.id, clientName(c.id)])])));
    }
    items.push(field("Count by", select("basis", Object.entries(BASES).map(([k, [l]]) => [k, l]))));
    if (opts.split) {
        items.push(h("label", { class: "filter check" },
            h("input", { type: "checkbox", checked: REPORT.split && !REPORT.client, disabled: !!REPORT.client,
                         onchange: e => { REPORT.split = e.target.checked; render(); } }),
            h("span", null, "Split by client")));
    }
    return h("div", { class: "filters" }, items);
}

function basisNotes(slice) {
    const notes = [h("p", { class: "hint" }, BASES[REPORT.basis][1])];
    const fallback = slice.rows.filter(r => r.fallback).length;
    if (fallback) {
        const what = REPORT.basis === "paid" ? "payment date" : "service period";
        notes.push(h("div", { class: "banner" },
            `${fallback} invoice(s) in this selection have no ${what} recorded and are counted by invoice date.`));
    }
    if (slice.excluded) {
        notes.push(h("div", { class: "banner" },
            `${slice.excluded} invoice(s) in other currencies than ${slice.currency} are not included.`));
    }
    return notes;
}

function moneyTable(head, rows, foot, cls = "") {
    return h("table", { class: `list report ${cls}` },
        h("thead", null, h("tr", null, head.map(([label, num]) => h("th", { class: num ? "num" : null }, label)))),
        h("tbody", null, rows),
        foot ? h("tfoot", null, foot) : null);
}

/* Tax summary */

function taxView() {
    const slice = reportSlice();
    const { rows, currency } = slice;
    const schemes = Object.keys(S.meta.tax_schemes).filter(s => rows.some(r => r.inv.tax && r.inv.tax.scheme === s));
    const periods = periodRange(REPORT.gran, slice.from, slice.to);
    const byPeriod = groupBy(rows, r => periodKey(r.date, REPORT.gran), periods);
    const total = emptySums();
    rows.forEach(r => addTo(total, r.inv));

    const sumCells = s => [
        h("td", { class: "num" }, s.count),
        h("td", { class: "num" }, amount(s.net)),
        h("td", { class: "num" }, amount(s.vat)),
        h("td", { class: "num" }, amount(s.gross)),
        schemes.map(k => h("td", { class: "num" }, amount(s.schemes[k] || 0))),
    ];
    const summary = moneyTable(
        [["Period"], ["Invoices", true], [`Net (${currency})`, true], ["VAT", true], ["Gross", true],
         ...schemes.map(k => [`Net: ${schemeLabel(k)}`, true])],
        [...byPeriod].map(([k, s]) => h("tr", { class: s.count ? null : "zero" },
                                         h("td", null, periodLabel(k)), sumCells(s))),
        h("tr", null, h("td", null, "Total"), sumCells(total)));

    // Per client, e.g. for the Zusammenfassende Meldung.
    const colKeys = REPORT.year === "all"
        ? periodRange("year", slice.from, slice.to)
        : periodRange("quarter", slice.from, slice.to);
    const byClient = new Map();
    for (const r of rows) {
        const id = r.inv.client;
        if (!byClient.has(id)) byClient.set(id, { inv: r.inv, total: 0, cols: {} });
        const c = byClient.get(id);
        const k = REPORT.year === "all" ? r.date.slice(0, 4) : periodKey(r.date, "quarter");
        c.cols[k] = (c.cols[k] || 0) + r.inv._.net_cents;
        c.total += r.inv._.net_cents;
        if (r.inv.issue_date > c.inv.issue_date) c.inv = r.inv;
    }
    const clientRows = [...byClient].sort((a, b) => b[1].total - a[1].total).map(([id, c]) => {
        const client = S.clients[id] || {};
        const recip = c.inv.recipient || {};
        return h("tr", { onclick: () => go("client", id) },
            h("td", null, clientName(id)),
            h("td", null, client.country || recip.country || ""),
            h("td", { class: "nowrap" }, client.vat_id || recip.vat_id || "—"),
            h("td", null, schemeLabel(client.tax_scheme || (c.inv.tax && c.inv.tax.scheme))),
            colKeys.map(k => h("td", { class: "num" }, c.cols[k] ? amount(c.cols[k]) : "—")),
            h("td", { class: "num" }, h("strong", null, amount(c.total))));
    });
    const clients = moneyTable(
        [["Client"], ["Country"], ["VAT ID"], ["Tax treatment"],
         ...colKeys.map(k => [periodLabel(k), true]), [`Net (${currency})`, true]],
        clientRows, null, "clickable");

    const invoiceRows = [...rows].sort((a, b) => b.date.localeCompare(a.date)).map(r =>
        h("tr", { onclick: () => go("invoice", r.inv.id) },
            h("td", null, r.inv.number),
            h("td", null, clientName(r.inv.client)),
            h("td", { class: "date" }, r.date, r.fallback ? h("span", { class: "muted", title: "Fallback: invoice date" }, " *") : null),
            h("td", { class: "num" }, amount(r.inv._.net_cents)),
            h("td", { class: "num" }, amount(r.inv._.vat_cents)),
            h("td", { class: "num" }, amount(r.inv._.gross_cents)),
            h("td", null, badge(r.inv._.status))));
    const invoices = moneyTable(
        [["Number"], ["Client"], [BASES[REPORT.basis][0]], [`Net (${currency})`, true], ["VAT", true],
         ["Gross", true], ["Status"]],
        invoiceRows, null, "clickable");

    const scope = REPORT.year === "all" ? "all years" : REPORT.year;
    return [
        h("div", { class: "page-head" }, h("h1", null, "Tax summary"), h("span", { class: "sub" }, scope),
          h("div", { class: "spacer" }),
          h("button", { onclick: () => downloadCsv(rows, scope), disabled: !rows.length }, "Export CSV")),
        reportFilters(),
        basisNotes(slice),
        h("h2", null, `By ${GRANS[REPORT.gran].toLowerCase()}`), summary,
        h("h2", null, "By client"), byClient.size ? clients : h("div", { class: "empty" }, "No invoices in this selection."),
        h("h2", null, `Invoices (${rows.length})`), rows.length ? invoices : null,
    ];
}

function csvCell(v) {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, scope) {
    const head = ["id", "number", "client", "recipient", "country", "vat_id", "tax_treatment", "report_date",
                  "invoice_date", "service_from", "service_to", "paid_date", "status",
                  "net", "vat", "gross", "currency"];
    const lines = [head.join(",")];
    for (const { inv, date } of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
        const r = inv.recipient || {}, sp = inv.service_period || {}, c = S.clients[inv.client] || {};
        // Old invoices did not always print the VAT ID; the client record has it.
        lines.push([inv.id, inv.number, clientName(inv.client), r.name, r.country || c.country,
                    r.vat_id || c.vat_id,
                    inv.tax && inv.tax.scheme, date, inv.issue_date, sp.from, sp.to, inv.paid_date,
                    inv.status, (inv._.net_cents / 100).toFixed(2), (inv._.vat_cents / 100).toFixed(2),
                    (inv._.gross_cents / 100).toFixed(2), inv.currency || "EUR"].map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const a = h("a", { href: URL.createObjectURL(blob),
                       download: `invoices-${scope.replace(/ /g, "-")}-${REPORT.basis}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
