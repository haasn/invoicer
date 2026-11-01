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
            ...clientsByRecent().map(c => [c.id, clientName(c.id)])])));
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
        [...byPeriod].reverse().map(([k, s]) => h("tr", { class: s.count ? null : "zero" },
                                         h("td", null, periodLabel(k)), sumCells(s))),
        h("tr", null, h("td", null, "Total"), sumCells(total)));

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
        euSection(rows, currency),
        h("h2", null, `By ${GRANS[REPORT.gran].toLowerCase()}`), summary,
        h("h2", null, `Invoices (${rows.length})`), rows.length ? invoices : null,
    ];
}

// Reverse-charge services to EU businesses per quarter and client: the lines
// of the Zusammenfassende Meldung; each quarter's total goes into Kennzahl 21
// of the USt-Voranmeldung.
function euSection(rows, currency) {
    const vatIdOf = inv => (inv.recipient && inv.recipient.vat_id) || (S.clients[inv.client] || {}).vat_id || "";
    const eu = rows.filter(r => r.inv.tax && r.inv.tax.scheme === "eu_reverse_charge");
    const missing = eu.filter(r => !vatIdOf(r.inv));

    const quarters = new Map();
    for (const r of [...eu].sort((a, b) => b.date.localeCompare(a.date))) {
        const vatId = vatIdOf(r.inv).replace(/\s+/g, "");
        if (!vatId) continue;
        const q = periodKey(r.date, "quarter");
        if (!quarters.has(q)) quarters.set(q, new Map());
        const lines = quarters.get(q);
        const key = `${r.inv.client}|${vatId}`;
        if (!lines.has(key)) lines.set(key, { client: r.inv.client, vatId, net: 0, count: 0 });
        const line = lines.get(key);
        line.net += r.inv._.net_cents;
        line.count += 1;
    }

    const body = [];
    for (const [q, lines] of quarters) {
        const sorted = [...lines.values()].sort((a, b) => clientName(a.client).localeCompare(clientName(b.client)));
        sorted.forEach((l, i) => {
            const cc = l.vatId.slice(0, 2);     // the VAT ID prefix, e.g. EL for Greece
            body.push(h("tr", { onclick: () => go("client", l.client) },
                h("td", { class: i ? "muted" : null }, periodLabel(q)),
                h("td", null, clientName(l.client)),
                h("td", { class: "flag", title: `${cc}: ${countryName({ EL: "GR" }[cc] || cc)}` }, flag(cc)),
                h("td", { class: "nowrap" }, l.vatId.slice(2)),
                h("td", { class: "num" }, l.count),
                h("td", { class: "num" }, amount(l.net))));
        });
        const total = sorted.reduce((a, l) => a + l.net, 0);
        body.push(h("tr", { class: "subtotal" },
            h("td", { colspan: 5 }, `${periodLabel(q)} total (USt-VA Kennzahl 21)`),
            h("td", { class: "num" }, amount(total))));
    }

    const notes = [];
    if (REPORT.basis !== "service") {
        notes.push(h("p", { class: "hint" },
            "Reverse-charge services are reported for the period in which the service was performed "
            + "(§ 18b UStG), i.e. by service period end. ",
            h("button", { class: "small", onclick: () => { REPORT.basis = "service"; render(); } },
              "Count by service period end")));
    }
    if (missing.length) {
        notes.push(h("div", { class: "banner" },
            `${missing.length} EU reverse-charge invoice(s) have no recipient VAT ID and are not listed: `
            + missing.map(r => `${r.inv.number} (${clientName(r.inv.client)})`).join(", ")));
    }
    return [
        h("h2", null, "EU reverse-charge services by client"),
        notes,
        quarters.size
            ? moneyTable([["Quarter"], ["Client"], ["Country"], ["VAT number"], ["Invoices", true],
                          [`Net (${currency})`, true]], body, null, "clickable")
            : h("div", { class: "empty" }, "No reverse-charge services to EU businesses in this selection."),
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

/* Income & trends */

const SVG_NS = "http://www.w3.org/2000/svg";
const SERIES_SLOTS = 7;     // categorical colors; further clients fold into "Other"
let vizObservers = [];

function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "style") Object.entries(v).forEach(([p, val]) => el.style.setProperty(p, val));
        else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
        if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
}

// Colors follow the client, ranked by all-time revenue, so filters never repaint.
function clientSeries() {
    const totals = {};
    for (const inv of S.invoices) {
        if (inv.status !== "cancelled") totals[inv.client] = (totals[inv.client] || 0) + inv._.net_cents;
    }
    const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a] || a.localeCompare(b));
    const series = {};
    ranked.forEach((id, i) => {
        series[id] = i < SERIES_SLOTS
            ? { id, label: clientName(id), color: `var(--viz-${i + 1})`, rank: i }
            : { id: "_other", label: "Other", color: "var(--viz-other)", rank: SERIES_SLOTS };
    });
    return series;
}

const fmt0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function compact(c) {
    const v = c / 100;
    if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
    if (Math.abs(v) >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
    return fmt0.format(v);
}

function niceStep(max, n) {
    const raw = max / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => raw <= s);
}

function yScale(max, ph, top) {
    const step = niceStep(Math.max(max, 100), 4);
    const limit = Math.ceil(Math.max(max, 1) / step) * step;
    return { step, limit, y: v => top + ph - (v / limit) * ph };
}

function lineKey(color) {
    const k = h("span", { class: "key" });
    k.style.background = color;
    return k;
}

function showTip(tip, body, x, y) {
    tip.replaceChildren(...body.flat(Infinity).filter(x => x != null));
    tip.hidden = false;
    const box = tip.parentElement.getBoundingClientRect();
    const left = x + 14 + tip.offsetWidth > box.width ? x - 14 - tip.offsetWidth : x + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight / 2)}px`;
}

function tipRows(title, rows, total) {
    return [h("div", { class: "tip-title" }, title),
            rows.map(r => h("div", { class: "tip-row" }, lineKey(r.color),
                            h("strong", null, amount(r.value)), h("span", { class: "muted" }, r.label))),
            total != null ? h("div", { class: "tip-row total" }, h("strong", null, amount(total)),
                              h("span", { class: "muted" }, "Total")) : null];
}

function pointerPos(evt, el) {
    const box = el.closest(".viz-body").getBoundingClientRect();
    if (evt.clientX == null) {
        const r = evt.target.getBoundingClientRect();
        return [r.left + r.width / 2 - box.left, r.top + 20 - box.top];
    }
    return [evt.clientX - box.left, evt.clientY - box.top];
}

function legend(series, kind = "rect") {
    if (series.length < 2) return null;
    return h("div", { class: "viz-legend" }, series.map(s => {
        const key = h("span", { class: kind === "line" ? "key" : "swatch" });
        key.style.background = s.color;
        return h("span", null, key, s.label);
    }));
}

// A chart card; `draw(width, tip)` is re-run whenever the plot width changes.
function chartCard(id, title, subtitle, legendEl, draw, table) {
    const plot = h("div", { class: "viz-plot" });
    const tip = h("div", { class: "viz-tip", hidden: true });
    const showTable = !!REPORT.tables[id];
    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
        const w = Math.floor(plot.clientWidth);
        if (w && w !== lastWidth) {
            lastWidth = w;
            tip.hidden = true;
            plot.replaceChildren(draw(w, tip));
        }
    });
    ro.observe(plot);
    vizObservers.push(ro);
    return h("figure", { class: "viz" },
        h("figcaption", null,
          h("div", null, h("h3", null, title), subtitle ? h("p", { class: "hint" }, subtitle) : null),
          h("button", { class: "small", onclick: () => { REPORT.tables[id] = !showTable; render(); } },
            showTable ? "Hide table" : "Show table")),
        legendEl,
        h("div", { class: "viz-body", onpointerleave: () => { tip.hidden = true; } }, plot, tip),
        showTable ? table() : null);
}

function roundedTop(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function drawColumns(w, tip, periods, series) {
    const H = 260, m = { t: 14, r: 8, b: 30, l: 52 };
    const pw = w - m.l - m.r, ph = H - m.t - m.b;
    const { step, limit, y } = yScale(Math.max(0, ...periods.map(p => p.total)), ph, m.t);
    const band = pw / periods.length;
    const bw = Math.max(2, Math.min(24, band * 0.6));
    const root = svg("svg", { width: w, height: H, class: "viz-svg", role: "img",
                              "aria-label": "Net income per period; see the table view for values" });

    for (let v = 0; v <= limit; v += step) {
        root.append(svg("line", { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }),
                    svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, compact(v)));
    }
    const labelWidth = Math.max(...periods.map(p => p.short.length)) * 6.5 + 10;
    const every = Math.ceil(labelWidth / band);
    const lastWithData = periods.map(p => p.total > 0).lastIndexOf(true);

    periods.forEach((p, i) => {
        const cx = m.l + band * (i + 0.5);
        const segs = series.filter(s => p.values[s.id] > 0);
        let acc = 0;
        segs.forEach((s, j) => {
            let top = y(acc + p.values[s.id]), bottom = y(acc);
            acc += p.values[s.id];
            if (j > 0) bottom -= 1;                 // 2px surface gap between segments
            if (j < segs.length - 1) top += 1;
            if (bottom - top < 0.5) return;
            const isTop = j === segs.length - 1;
            root.append(svg("path", { style: { fill: s.color },
                d: isTop ? roundedTop(cx - bw / 2, top, bw, bottom - top, 4)
                         : `M${cx - bw / 2},${top}h${bw}V${bottom}h${-bw}Z` }));
        });
        if ((periods.length - 1 - i) % every === 0) {
            root.append(svg("text", { x: cx, y: H - 10, class: "tick", "text-anchor": "middle" }, p.short));
        }
        if (i === lastWithData && labelWidth < w / 3) {
            root.append(svg("text", { x: cx, y: y(p.total) - 6, class: "value", "text-anchor": "middle" },
                            compact(p.total)));
        }
        const show = evt => {
            const rows = segs.length > 1 || series.length > 1
                ? segs.map(s => ({ color: s.color, label: s.label, value: p.values[s.id] })).reverse() : [];
            const total = rows.length > 1 ? p.total : null;
            const body = rows.length ? tipRows(p.label, rows, total)
                : tipRows(p.label, [{ color: series[0].color, label: series[0].label, value: p.total }]);
            showTip(tip, body, ...pointerPos(evt, root));
        };
        root.append(svg("rect", { x: m.l + band * i, y: m.t, width: band, height: ph, class: "hit",
                                  tabindex: 0, "aria-label": `${p.label}: ${amount(p.total)}`,
                                  onpointermove: show, onfocus: show, onblur: () => { tip.hidden = true; } }));
    });
    return root;
}

function drawCumulative(w, tip, years) {
    const H = 260, m = { t: 14, r: 52, b: 30, l: 52 };
    const pw = w - m.l - m.r, ph = H - m.t - m.b;
    const max = Math.max(0, ...years.flatMap(s => s.values.filter(v => v != null)));
    const { step, limit, y } = yScale(max, ph, m.t);
    const x = i => m.l + pw * i / 11;
    const root = svg("svg", { width: w, height: H, class: "viz-svg", role: "img",
                              "aria-label": "Cumulative net income per year; see the table view for values" });

    for (let v = 0; v <= limit; v += step) {
        root.append(svg("line", { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }),
                    svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, compact(v)));
    }
    const monthEvery = pw / 12 < 30 ? 3 : 1;
    MONTHS.forEach((name, i) => {
        if (i % monthEvery === 0) {
            root.append(svg("text", { x: x(i), y: H - 10, class: "tick", "text-anchor": "middle" }, name));
        }
    });

    // Context years first, the highlighted year on top.
    const ordered = [...years].sort((a, b) => a.emphasis - b.emphasis);
    const ends = [];
    for (const s of ordered) {
        const pts = s.values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
        if (!pts.length) continue;
        root.append(svg("path", { class: "line", style: { stroke: s.color },
                                  d: "M" + pts.map(p => p.join(",")).join("L") }));
        const [ex, ey] = pts[pts.length - 1];
        if (s.emphasis) root.append(svg("circle", { cx: ex, cy: ey, r: 4, class: "dot", style: { fill: s.color } }));
        ends.push({ x: ex, y: ey, label: s.label, emphasis: s.emphasis });
    }
    // Direct end labels, skipping any that would collide (the legend carries those).
    ends.sort((a, b) => b.emphasis - a.emphasis);
    const placed = [];
    for (const e of ends) {
        if (placed.some(p => Math.abs(p.y - e.y) < 13 && Math.abs(p.x - e.x) < 40)) continue;
        placed.push(e);
        root.append(svg("text", { x: e.x + 8, y: e.y + 4, class: e.emphasis ? "value" : "tick" }, e.label));
    }

    const cross = svg("line", { y1: m.t, y2: m.t + ph, class: "crosshair", visibility: "hidden" });
    root.append(cross);
    let current = null;
    const showAt = (i, evt) => {
        current = i;
        cross.setAttribute("x1", x(i));
        cross.setAttribute("x2", x(i));
        cross.setAttribute("visibility", "visible");
        const rows = years.filter(s => s.values[i] != null)
            .sort((a, b) => b.values[i] - a.values[i])
            .map(s => ({ color: s.color, label: s.label, value: s.values[i] }));
        const pos = evt && evt.clientX != null ? pointerPos(evt, root) : [x(i), m.t + 20];
        showTip(tip, tipRows(`Through ${MONTHS[i]}`, rows), ...pos);
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    root.append(svg("rect", {
        x: m.l - 10, y: m.t, width: pw + 20, height: ph, class: "hit overlay", tabindex: 0,
        "aria-label": "Cumulative income by month; use the arrow keys",
        onpointermove: evt => {
            const box = root.getBoundingClientRect();
            showAt(Math.max(0, Math.min(11, Math.round((evt.clientX - box.left - m.l) / pw * 11))), evt);
        },
        onpointerleave: hide, onblur: hide,
        onfocus: () => showAt(current ?? Number(S.today.slice(5, 7)) - 1),
        onkeydown: evt => {
            const d = { ArrowLeft: -1, ArrowRight: 1 }[evt.key];
            if (d) { evt.preventDefault(); showAt(Math.max(0, Math.min(11, (current ?? 0) + d))); }
        },
    }));
    return root;
}

function statTile(label, value, sub, delta) {
    return h("div", { class: "stat" },
        h("div", { class: "label" }, label),
        h("div", { class: "value" }, value),
        delta ? h("div", { class: `delta ${delta.up ? "up" : "down"}` }, delta.up ? "▲ " : "▼ ", delta.text) : null,
        sub ? h("div", { class: "label" }, sub) : null);
}

function monthsBetween(from, to) {
    return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
        + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

// Income in the same window of the previous year, for the comparison tile.
function yearComparison(rowsAllYears) {
    const year = REPORT.year === "all" ? S.today.slice(0, 4) : REPORT.year;
    const prev = String(Number(year) - 1);
    const cutoff = year === S.today.slice(0, 4) ? S.today.slice(5) : "12-31";
    const sum = y => rowsAllYears.filter(r => r.date.startsWith(y) && r.date.slice(5) <= cutoff)
        .reduce((a, r) => a + r.inv._.net_cents, 0);
    const cur = sum(year), before = sum(prev);
    const window = cutoff === "12-31" ? year : `${year} to date`;
    if (!before) return statTile(`Net income ${window}`, cents(cur), `No income in ${prev} to compare`);
    const pct = (cur - before) / before * 100;
    return statTile(`Net income ${window}`, cents(cur), `vs ${cents(before)} in the same period of ${prev}`,
                    { up: pct >= 0, text: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs ${prev}` });
}

function incomeView() {
    vizObservers.forEach(o => o.disconnect());
    vizObservers = [];
    const slice = reportSlice({ withClient: true });
    const { rows, currency } = slice;
    const split = REPORT.split && !REPORT.client;
    const clientInfo = clientSeries();

    // Same filters except the year, for the comparisons across years.
    const allYears = reportRows().filter(r => (r.inv.currency || "EUR") === currency
        && (!REPORT.client || r.inv.client === REPORT.client));

    const total = rows.reduce((a, r) => a + r.inv._.net_cents, 0);
    const months = monthsBetween(slice.from, slice.to);
    const scope = REPORT.year === "all" ? "all years" : REPORT.year;
    const tiles = h("div", { class: "stats" },
        statTile(`Net income, ${scope}`, cents(total, currency), `${rows.length} invoice(s)`),
        statTile("Monthly average", cents(Math.round(total / months), currency),
                 `over ${months} month${months === 1 ? "" : "s"}`),
        yearComparison(allYears));

    // Column chart: net income per period, optionally stacked by client.
    const keys = periodRange(REPORT.gran, slice.from, slice.to);
    const periods = keys.map(k => ({ key: k, label: periodLabel(k), short: periodLabel(k, true), values: {}, total: 0 }));
    const byKey = Object.fromEntries(periods.map(p => [p.key, p]));
    const used = new Map();
    const single = { id: "_all", label: REPORT.client ? clientName(REPORT.client) : "Net income",
                     color: "var(--primary)", rank: 0 };
    for (const r of rows) {
        const p = byKey[periodKey(r.date, REPORT.gran)];
        if (!p) continue;
        const s = split ? clientInfo[r.inv.client] : single;
        used.set(s.id, s);
        p.values[s.id] = (p.values[s.id] || 0) + r.inv._.net_cents;
        p.total += r.inv._.net_cents;
    }
    const series = [...used.values()].sort((a, b) => a.rank - b.rank);
    if (!series.length) series.push(single);

    const columns = chartCard("columns", `Net income per ${GRANS[REPORT.gran].toLowerCase()}`,
        split ? "Stacked by client, largest client at the bottom." : null,
        legend(series),
        (w, tip) => drawColumns(w, tip, periods, series),
        () => moneyTable([[GRANS[REPORT.gran]], ...(series.length > 1 ? series.map(s => [s.label, true]) : []),
                          [`Net (${currency})`, true]],
            periods.map(p => h("tr", { class: p.total ? null : "zero" }, h("td", null, p.label),
                series.length > 1 ? series.map(s => h("td", { class: "num" }, amount(p.values[s.id] || 0))) : null,
                h("td", { class: "num" }, amount(p.total)))),
            null, "viz-table"));

    // Cumulative income through the year, one line per year.
    const highlight = REPORT.year === "all" ? S.today.slice(0, 4) : REPORT.year;
    const yearList = reportYears(allYears).slice(0, 6).reverse();
    const yearSeries = yearList.map(year => {
        const monthly = Array(12).fill(0);
        allYears.filter(r => r.date.startsWith(year))
            .forEach(r => { monthly[Number(r.date.slice(5, 7)) - 1] += r.inv._.net_cents; });
        let acc = 0;
        const lastMonth = year === S.today.slice(0, 4) ? Number(S.today.slice(5, 7)) - 1 : 11;
        const values = monthly.map((v, i) => (acc += v, i <= lastMonth ? acc : null));
        const emphasis = year === highlight;
        return { label: year, values, emphasis, color: emphasis ? "var(--primary)" : "var(--viz-muted)" };
    });
    const cumulative = chartCard("cumulative", "Cumulative net income by year",
        `${highlight} highlighted, earlier years for comparison.`,
        legend([...yearSeries].reverse(), "line"),
        (w, tip) => drawCumulative(w, tip, yearSeries),
        () => moneyTable([["Through"], ...yearSeries.map(s => [s.label, true])],
            MONTHS.map((name, i) => h("tr", null, h("td", null, name),
                yearSeries.map(s => h("td", { class: "num" }, s.values[i] == null ? "—" : amount(s.values[i]))))),
            null, "viz-table"));

    // Share per client in the selected slice (ignores the client filter).
    const shareRows = reportSlice().rows;
    const shareTotal = shareRows.reduce((a, r) => a + r.inv._.net_cents, 0);
    const perClient = {};
    shareRows.forEach(r => { perClient[r.inv.client] = (perClient[r.inv.client] || 0) + r.inv._.net_cents; });
    const ranked = Object.entries(perClient).sort((a, b) => b[1] - a[1]);
    const maxShare = ranked.length ? ranked[0][1] : 1;
    const shares = h("figure", { class: "viz" },
        h("figcaption", null, h("div", null, h("h3", null, `Net income by client, ${scope}`))),
        ranked.length ? h("div", { class: "ranked" }, ranked.map(([id, c]) => {
            const bar = h("span", { class: "bar" });
            bar.style.width = `${(c / maxShare) * 100}%`;
            return h("div", { class: `ranked-row ${REPORT.client && REPORT.client !== id ? "dim" : ""}`,
                              onclick: () => go("client", id) },
                h("span", { class: "name" }, clientName(id)),
                h("span", { class: "track" }, bar),
                h("span", { class: "num" }, amount(c)),
                h("span", { class: "num muted" }, `${(c / shareTotal * 100).toFixed(1)}%`));
        })) : h("div", { class: "empty" }, "No income in this selection."));

    return [
        h("div", { class: "page-head" }, h("h1", null, "Income & trends"), h("span", { class: "sub" }, scope)),
        reportFilters({ clients: true, split: true }),
        basisNotes(slice),
        tiles,
        columns,
        cumulative,
        shares,
    ];
}
