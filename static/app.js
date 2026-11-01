"use strict";

const TOKEN = document.querySelector('meta[name="token"]').content;
const STATUS_FILTERS = ["all", "open", "overdue", "paid", "draft", "cancelled"];

let S = null;              // state from /api/state
let statusFilter = "all";
let ed = null;             // open draft editor, see draftView()

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
    if (ed && !(view === "draft" && id === ed.id)) closeEditor();
    const views = {
        "": () => listView(null),
        client: () => listView(id),
        invoice: () => invoiceView(id),
        draft: () => draftView(id),
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

function headActions(client) {
    if (client) {
        return h("button", { class: "primary", onclick: () => newDraft(client.id) }, "+ New invoice");
    }
    const clients = Object.values(S.clients).filter(c => !c.archived);
    if (!clients.length) return [];
    const select = h("select", null, clients.map(c => h("option", { value: c.id }, c.name)));
    return [select, h("button", { class: "primary", onclick: () => newDraft(select.value) }, "+ New invoice")];
}

async function newDraft(clientId, from) {
    try {
        const draft = await api("POST", "/api/drafts", { client: clientId, from });
        S.drafts.push(draft);
        go("draft", draft.id);
    } catch (e) {
        showError(e);
    }
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

function invoiceActions(inv) {
    return [
        h("button", { onclick: () => newDraft(inv.client, inv.id) }, "Duplicate as draft"),
    ];
}

function fact(label, value) {
    return [h("dt", null, label), h("dd", null, value)];
}

/* Draft editor */

const EDITABLE = ["client", "issue_date", "due_date", "service_period", "title",
                  "intro", "items", "outro", "email_body", "number"];

function payload(draft) {
    return Object.fromEntries(EDITABLE.filter(k => k in draft).map(k => [k, draft[k]]));
}

function addDays(iso, days) {
    const d = new Date(iso + "T12:00:00Z");
    if (isNaN(d)) return "";
    d.setUTCDate(d.getUTCDate() + Number(days));
    return d.toISOString().slice(0, 10);
}

function monthRange(iso, offset) {
    const d = new Date(iso + "T12:00:00Z");
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1, 12));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0, 12));
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

function dueDays(clientId) {
    const c = S.clients[clientId] || {};
    return c.due_days || S.settings.due_days || 21;
}

function lineAmount(item) {
    const v = parseFloat(item.qty) * parseFloat(item.price);
    return isFinite(v) ? fmt.format(v) : "?";
}

function closeEditor() {
    const old = ed;
    ed = null;
    clearTimeout(old.timer);
    if (old.previewUrl) URL.revokeObjectURL(old.previewUrl);
    if (old.dirty) flush(old).catch(showError);
}

function draftView(id) {
    const stored = S.drafts.find(d => d.id === id);
    if (!stored) return h("div", { class: "empty" }, "This draft no longer exists.");
    if (ed && ed.id === id) return ed.root;

    const draft = structuredClone(stored);
    delete draft._;
    ed = { id, draft, dirty: false, timer: null, previewSeq: 0, previewUrl: null, saved: stored };

    const changed = () => {
        ed.dirty = true;
        setEdStatus("Unsaved changes");
        clearTimeout(ed.timer);
        const mine = ed;
        ed.timer = setTimeout(() => flush(mine).catch(showError), 600);
    };

    const field = (label, input, cls = "") => h("label", { class: `field ${cls}` }, h("span", null, label), input);
    const text = (key, attrs = {}) => h("input", {
        type: "text", value: draft[key] || "", ...attrs,
        oninput: e => { draft[key] = e.target.value; changed(); } });
    const area = (key, rows, placeholder) => h("textarea", {
        rows, placeholder, value: draft[key] || "",
        oninput: e => { draft[key] = e.target.value; changed(); } });

    const due = h("input", { type: "date", value: draft.due_date,
        oninput: e => { draft.due_date = e.target.value; changed(); } });
    const issue = h("input", { type: "date", value: draft.issue_date, oninput: e => {
        draft.issue_date = e.target.value;
        draft.due_date = due.value = addDays(draft.issue_date, dueDays(draft.client));
        changed();
    } });

    const period = draft.service_period = draft.service_period || { from: "", to: "" };
    const pFrom = h("input", { type: "date", value: period.from,
        oninput: e => { period.from = e.target.value; changed(); } });
    const pTo = h("input", { type: "date", value: period.to,
        oninput: e => { period.to = e.target.value; changed(); } });
    const setPeriod = offset => () => {
        const r = monthRange(draft.issue_date || S.today, offset);
        period.from = pFrom.value = r.from;
        period.to = pTo.value = r.to;
        changed();
    };

    const clientSelect = h("select", { onchange: e => {
        draft.client = e.target.value;
        draft.due_date = due.value = addDays(draft.issue_date, dueDays(draft.client));
        changed();
    } }, Object.values(S.clients)
        .filter(c => !c.archived || c.id === draft.client)
        .map(c => h("option", { value: c.id, selected: c.id === draft.client }, c.name)));

    const itemsBody = h("tbody");
    const renderItems = () => itemsBody.replaceChildren(...draft.items.map(itemRow));
    const move = (i, delta) => {
        const j = i + delta;
        if (j < 0 || j >= draft.items.length) return;
        [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]];
        renderItems();
        changed();
    };
    const itemRow = (item, i) => {
        const amount = h("td", { class: "num amount" }, lineAmount(item));
        const input = (key, attrs) => h("input", { type: "text", value: item[key], ...attrs,
            oninput: e => { item[key] = e.target.value.trim(); amount.textContent = lineAmount(item); changed(); } });
        return h("tr", null,
            h("td", { class: "desc" }, h("input", { type: "text", value: item.desc, placeholder: "Description",
                oninput: e => { item.desc = e.target.value; changed(); } })),
            h("td", { class: "qty" }, input("qty", { inputmode: "decimal" })),
            h("td", { class: "unit" }, h("select", { onchange: e => { item.unit = e.target.value; changed(); } },
                Object.entries(S.meta.units).map(([code, [one]]) =>
                    h("option", { value: code, selected: code === item.unit }, one || "unit")))),
            h("td", { class: "price" }, input("price", { inputmode: "decimal" })),
            amount,
            h("td", { class: "row-actions" },
                h("button", { class: "icon", title: "Move up", onclick: () => move(i, -1) }, "↑"),
                h("button", { class: "icon", title: "Move down", onclick: () => move(i, 1) }, "↓"),
                h("button", { class: "icon", title: "Duplicate", onclick: () => {
                    draft.items.splice(i + 1, 0, { ...item }); renderItems(); changed(); } }, "⧉"),
                h("button", { class: "icon", title: "Remove", onclick: () => {
                    draft.items.splice(i, 1); renderItems(); changed(); } }, "✕")));
    };
    const addItem = () => {
        const c = S.clients[draft.client] || {};
        draft.items.push({ desc: "", qty: "1", unit: c.rate_unit || "C62", price: c.rate || "" });
        renderItems();
        changed();
        itemsBody.lastChild.querySelector("input").focus();
    };
    renderItems();

    ed.status = h("span", { class: "ed-status muted" }, "Saved");
    ed.totals = h("div", { class: "ed-totals" });
    ed.problems = h("div");
    ed.issueBtn = h("span");
    ed.preview = h("iframe", { class: "pdf", title: "Preview" });

    const form = h("div", { class: "form" },
        h("div", { class: "page-head" },
          h("h1", null, draft.number ? `Invoice ${draft.number}` : "New invoice"), badge("draft"),
          h("div", { class: "spacer" }), ed.status),
        h("div", { class: "grid" },
          field("Client", clientSelect, "wide"),
          field("Title", text("title", { placeholder: "e.g. Consulting" }), "wide"),
          field("Invoice date", issue),
          field("Due date", due),
          field("Service period", h("div", { class: "period" }, pFrom, "–", pTo,
              h("button", { class: "small", onclick: setPeriod(-1) }, "last month"),
              h("button", { class: "small", onclick: setPeriod(0) }, "this month")), "wide")),
        field("Text above items", area("intro", 3, "Optional, e.g. milestone description. Blank line = new paragraph.")),
        h("table", { class: "items" },
          h("thead", null, h("tr", null, h("th", null, "Description"), h("th", { class: "qty" }, "Qty"),
            h("th", { class: "unit" }, "Unit"), h("th", { class: "price num" }, "Price"),
            h("th", { class: "amount num" }, "Amount"), h("th", { class: "row-actions" }))),
          itemsBody),
        h("div", { class: "items-foot" },
          h("button", { onclick: addItem }, "+ Add item"), h("div", { class: "spacer" }), ed.totals),
        field("Text below totals", area("outro", 2, "Optional closing text")),
        field("Cover email (not printed)", area("email_body", 5, "Text for the email you send with the PDF")),
        ed.problems,
        h("div", { class: "actions" },
          ed.issueBtn,
          h("button", { class: "danger", onclick: () => deleteDraft(id) }, "Delete draft")));

    ed.root = h("div", { class: "detail editor" }, form, ed.preview);
    updateEdInfo(stored);
    refreshPreview(ed);
    return ed.root;
}

function setEdStatus(msg) {
    if (ed) ed.status.textContent = msg;
}

function updateEdInfo(saved) {
    ed.saved = saved;
    const cur = (S.clients[ed.draft.client] || {}).currency || "EUR";
    ed.totals.replaceChildren(
        h("span", { class: "muted" }, "Net"), h("span", { class: "num" }, money(saved._.net, cur)),
        h("span", { class: "muted" }, "VAT"), h("span", { class: "num" }, money(saved._.vat, cur)),
        h("strong", null, "Total"), h("strong", { class: "num" }, money(saved._.gross, cur)));
    const problems = saved._.problems || [];
    ed.problems.replaceChildren(problems.length
        ? h("div", { class: "banner" }, h("strong", null, "Required before issuing"),
            h("ul", null, problems.map(p => h("li", null, p))))
        : []);
    ed.issueBtn.replaceChildren(...issueButton(saved));
}

function issueButton(_saved) {
    return [];
}

async function flush(e) {
    clearTimeout(e.timer);
    if (!e.dirty) return;
    e.dirty = false;
    if (ed === e) setEdStatus("Saving…");
    const saved = await api("PUT", `/api/drafts/${encodeURIComponent(e.id)}`, payload(e.draft));
    const idx = S.drafts.findIndex(d => d.id === e.id);
    if (idx >= 0) S.drafts[idx] = saved;
    if (ed !== e) return;
    updateEdInfo(saved);
    setEdStatus(e.dirty ? "Unsaved changes" : "Saved");
    refreshPreview(e);
}

async function refreshPreview(e) {
    const seq = ++e.previewSeq;
    try {
        const blob = await api("POST", "/api/preview", payload(e.draft));
        if (seq !== e.previewSeq || ed !== e) return;
        if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
        e.previewUrl = URL.createObjectURL(blob);
        e.preview.src = e.previewUrl + "#zoom=page-width";
    } catch (err) {
        if (ed === e) setEdStatus("Preview failed: " + err.message);
    }
}

async function deleteDraft(id) {
    if (!confirm("Delete this draft?")) return;
    try {
        if (ed && ed.id === id) { clearTimeout(ed.timer); ed.dirty = false; }
        await api("DELETE", `/api/drafts/${encodeURIComponent(id)}`);
        const d = S.drafts.find(x => x.id === id);
        S.drafts = S.drafts.filter(x => x.id !== id);
        go("client", d ? d.client : "");
    } catch (e) {
        showError(e);
    }
}

reload().catch(showError);
