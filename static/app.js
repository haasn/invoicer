"use strict";

const TOKEN = document.querySelector('meta[name="token"]').content;
const STATUS_FILTERS = ["all", "open", "overdue", "paid", "draft", "cancelled"];

let S = null;              // state from /api/state
let statusFilter = "all";

/* Helpers */

function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "class") el.className = v;
        else if (k === "value" || k === "checked") el[k] = v;
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : String(c));
    }
    return el;
}

async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: { "X-Token": TOKEN, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get("Content-Type") || "";
    if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`, problems = [];
        if (type.includes("json")) {
            const j = await res.json();
            msg = j.error || msg;
            problems = j.problems || [];
        }
        const err = new Error(msg);
        err.problems = problems;
        throw err;
    }
    return type.includes("pdf") ? res.blob() : res.json();
}

function toast(msg, kind = "info") {
    const el = h("div", { class: `toast ${kind}` }, msg);
    document.getElementById("toasts").append(el);
    setTimeout(() => el.remove(), kind === "error" ? 8000 : 3000);
}

function showError(e) {
    const extra = e.problems && e.problems.length ? "\n• " + e.problems.join("\n• ") : "";
    toast(e.message + extra, "error");
}

const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(amount, currency) {
    return `${currency || "EUR"} ${typeof amount === "number" ? fmt.format(amount) : amount}`;
}

function sumByCurrency(docs) {
    const sums = {};
    for (const d of docs) {
        const cur = d.currency || "EUR";
        sums[cur] = (sums[cur] || 0) + parseFloat(d._.gross_raw);
    }
    return Object.entries(sums).map(([cur, v]) => money(v, cur)).join(", ") || money(0);
}

function clientName(id) {
    const c = S.clients[id];
    return c ? c.name : id;
}

function badge(status) {
    return h("span", { class: `badge ${status}` }, status);
}

function isOutstanding(doc) {
    return doc._.status === "open" || doc._.status === "overdue";
}

function pdfUrl(id) {
    return `/api/invoices/${encodeURIComponent(id)}/pdf?t=${encodeURIComponent(TOKEN)}#zoom=page-width`;
}

/* Routing */

function route() {
    return location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
}

function go(...parts) {
    location.hash = "#/" + parts.map(encodeURIComponent).join("/");
}

async function reload() {
    S = await api("GET", "/api/state");
    render();
}

function render() {
    if (!S) return;
    renderSidebar();
    const [view, id] = route();
    const views = {
        "": () => listView(null),
        client: () => listView(id),
        invoice: () => invoiceView(id),
    };
    const main = document.getElementById("main");
    main.replaceChildren(...[problemsBanner(), (views[view] || views[""])()].flat());
}

window.addEventListener("hashchange", render);

/* Sidebar */

function renderSidebar() {
    const [view, id] = route();
    const navItem = (href, label, sum, active, extra = "") =>
        h("a", { class: `nav-item ${active ? "active" : ""} ${extra}`, href }, h("span", null, label),
          sum ? h("span", { class: "sum" }, sum) : null);

    const open = S.invoices.filter(isOutstanding);
    const items = [
        h("div", { class: "brand" },
          h("img", { src: "/logo.svg", alt: "" }),
          h("span", null, "haas", h("span", { class: "n" }, "n")),
          h("small", null, "invoices")),
        navItem("#/", "All invoices", open.length ? sumByCurrency(open) : "", view === "" || view === undefined),
        h("div", { class: "nav-head" }, "Clients"),
    ];
    for (const c of Object.values(S.clients)) {
        const outstanding = open.filter(i => i.client === c.id);
        const active = (view === "client" && id === c.id);
        items.push(navItem(`#/client/${encodeURIComponent(c.id)}`, c.name,
                           outstanding.length ? sumByCurrency(outstanding) : "",
                           active, c.archived ? "archived" : ""));
    }
    items.push(h("div", { class: "sidebar-foot" }, sidebarFoot()));
    document.getElementById("sidebar").replaceChildren(...items);
}

function sidebarFoot() {
    return [];
}

function problemsBanner() {
    if (!S.problems.length) return [];
    return h("div", { class: "banner bad" }, h("strong", null, "Data problems"),
             h("ul", null, S.problems.map(p => h("li", null, p))));
}

/* Invoice list */

function listView(clientId) {
    const client = clientId ? S.clients[clientId] : null;
    const mine = d => !clientId || d.client === clientId;
    const invoices = S.invoices.filter(mine);
    const drafts = S.drafts.filter(mine);
    const year = S.today.slice(0, 4);
    const outstanding = invoices.filter(isOutstanding);
    const overdue = invoices.filter(i => i._.status === "overdue");
    const thisYear = invoices.filter(i => i.status !== "cancelled" && (i.issue_date || "").startsWith(year));

    const head = h("div", { class: "page-head" },
        h("h1", null, client ? client.name : "All invoices"),
        client && client.code ? h("span", { class: "sub" }, client.code) : null,
        h("div", { class: "spacer" }),
        headActions(client));

    const stats = h("div", { class: "stats" },
        stat("Outstanding", sumByCurrency(outstanding), `${outstanding.length} invoice(s)`),
        overdue.length ? stat("Overdue", sumByCurrency(overdue), `${overdue.length} invoice(s)`) : null,
        stat(`Invoiced ${year}`, sumByCurrency(thisYear), `${thisYear.length} invoice(s)`));

    const chips = h("div", { class: "chips" }, STATUS_FILTERS.map(s =>
        h("button", { class: `chip ${statusFilter === s ? "active" : ""}`,
                      onclick: () => { statusFilter = s; render(); } }, s)));

    const docs = [...drafts, ...invoices].filter(d =>
        statusFilter === "all" || d._.status === statusFilter);
    const rows = docs.map(d => {
        const isDraft = d.status === "draft";
        const href = isDraft ? ["draft", d.id] : ["invoice", d.id];
        return h("tr", { onclick: () => go(...href) },
            h("td", null, isDraft ? h("span", { class: "muted" }, "—") : d.number),
            clientId ? null : h("td", null, clientName(d.client)),
            h("td", null, d.issue_date || ""),
            h("td", null, d.title || ""),
            h("td", { class: "num" }, money(d._.gross, d.currency)),
            h("td", null, badge(d._.status)));
    });

    const table = rows.length
        ? h("table", { class: "list" },
            h("thead", null, h("tr", null,
                h("th", null, "Number"), clientId ? null : h("th", null, "Client"),
                h("th", null, "Date"), h("th", null, "Title"),
                h("th", { class: "num" }, "Amount"), h("th", null, "Status"))),
            h("tbody", null, rows))
        : h("div", { class: "empty" }, "No invoices here yet.");

    return [head, stats, chips, table];
}

function headActions(_client) {
    return [];
}

function stat(label, value, sub) {
    return h("div", { class: "stat" },
             h("div", { class: "label" }, label),
             h("div", { class: "value" }, value),
             sub ? h("div", { class: "label" }, sub) : null);
}

/* Issued invoice */

function invoiceView(id) {
    const inv = S.invoices.find(i => i.id === id);
    if (!inv) return h("div", { class: "empty" }, `No invoice ${id}.`);
    const r = inv.recipient || {};

    const head = h("div", { class: "page-head" },
        h("h1", null, `Invoice ${inv.number}`), badge(inv._.status),
        h("div", { class: "spacer" }),
        h("a", { href: `#/client/${encodeURIComponent(inv.client)}` }, `← ${clientName(inv.client)}`));

    const period = inv.service_period ? `${inv.service_period.from} – ${inv.service_period.to}` : "—";
    const facts = h("dl", { class: "facts" },
        fact("Client", r.name || clientName(inv.client)),
        fact("Title", inv.title || "—"),
        fact("Issued", inv.issue_date),
        fact("Due", inv.due_date || "—"),
        fact("Service period", period),
        inv.paid_date ? fact("Paid", inv.paid_date) : null,
        fact("Net", money(inv._.net, inv.currency)),
        fact(`VAT ${inv.tax ? inv.tax.rate : 0}%`, money(inv._.vat, inv.currency)),
        fact("Total", h("strong", null, money(inv._.gross, inv.currency))),
        inv.legacy ? fact("Imported from", `${inv.legacy.branch} @ ${inv.legacy.commit.slice(0, 10)}`) : null);

    const left = h("div", null, head, facts,
        h("div", { class: "actions" }, invoiceActions(inv)),
        inv.email_body ? [h("h2", null, "Email text"), h("pre", { class: "email" }, inv.email_body)] : null);

    return h("div", { class: "detail" }, left,
             h("iframe", { class: "pdf", src: pdfUrl(inv.id), title: "Invoice PDF" }));
}

function invoiceActions(_inv) {
    return [];
}

function fact(label, value) {
    return [h("dt", null, label), h("dd", null, value)];
}

reload().catch(showError);
