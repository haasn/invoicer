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
        let data = {};
        if (type.includes("json")) {
            data = await res.json();
            msg = data.error || msg;
            problems = data.problems || [];
        }
        const err = new Error(msg);
        err.problems = problems;
        err.status = res.status;
        err.data = data;
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

function cents(c, currency) {
    return money(c / 100, currency);
}

function sumByCurrency(docs) {
    const sums = {};
    for (const d of docs) {
        const cur = d.currency || "EUR";
        sums[cur] = (sums[cur] || 0) + d._.gross_cents;
    }
    return Object.entries(sums).map(([cur, v]) => cents(v, cur)).join(", ") || money(0);
}

function clientName(id) {
    const c = S.clients[id];
    return c ? c.short_name || c.name : id;
}

// ISO 3166-1 alpha-2 country codes; the browser supplies the names.
const COUNTRY_CODES = (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN "
    + "BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ "
    + "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL "
    + "GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM "
    + "JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME "
    + "MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP "
    + "NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD "
    + "SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO "
    + "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ").trim().split(" ");
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code) {
    try {
        return regionNames.of(code);
    } catch (e) {
        return code;
    }
}

// Flag emoji from regional indicator symbols. VAT IDs use EL for Greece.
function flag(code) {
    code = { EL: "GR" }[code] || code;
    return /^[A-Z]{2}$/.test(code)
        ? String.fromCodePoint(...[...code].map(c => 0x1F1A5 + c.charCodeAt(0))) : "";
}

// Clients ordered by their most recent invoice (or draft), newest first.
function clientsByRecent() {
    const latest = {};
    for (const d of [...S.invoices, ...S.drafts]) {
        if (d.issue_date && !(latest[d.client] >= d.issue_date)) latest[d.client] = d.issue_date;
    }
    return Object.values(S.clients).sort((a, b) =>
        (latest[b.id] || "").localeCompare(latest[a.id] || "")
        || clientName(a.id).localeCompare(clientName(b.id)));
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
    S.resolved.forEach(note => toast(note));
    render();
}

function revisionOf(doc) {
    return (doc && doc.revision && doc.revision.id) || null;
}

function changedBy(err) {
    return `on ${err.data.changed_by || "another machine"} at ${(err.data.changed_at || "?").replace("T", " ").slice(0, 16)}`;
}

// Pick up changes synced from other machines when the tab becomes active,
// without discarding anything typed into a form here.
let lastRefresh = 0;
async function refresh() {
    if (!S || Date.now() - lastRefresh < 2000 || (ed && ed.dirty)) return;
    lastRefresh = Date.now();
    try {
        S = await api("GET", "/api/state");
    } catch (e) {
        return;
    }
    S.resolved.forEach(note => toast(note));
    const [view] = route();
    if (view === "edit-client" || view === "settings") return renderSidebar();
    if (ed && !ed.dirty && revisionOf(S.drafts.find(d => d.id === ed.id)) !== ed.base) ed = null;
    render();
}

window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

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
        "edit-client": () => clientForm(id),
        settings: () => settingsForm(),
        reports: () => id === "tax" ? taxView() : incomeView(),
    };
    const main = document.getElementById("main");
    main.replaceChildren(...[problemsBanner(), (views[view] || views[""])()]
        .flat(Infinity).filter(x => x != null && x !== false));
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
    for (const c of clientsByRecent()) {
        const outstanding = open.filter(i => i.client === c.id);
        const active = (view === "client" && id === c.id);
        items.push(navItem(`#/client/${encodeURIComponent(c.id)}`, clientName(c.id),
                           outstanding.length ? sumByCurrency(outstanding) : "",
                           active, c.archived ? "archived" : ""));
    }
    items.push(navItem("#/edit-client/", "+ New client", "", view === "edit-client" && !id, "add"));
    items.push(h("div", { class: "nav-head" }, "Reports"));
    items.push(navItem("#/reports/income", "Income & trends", "", view === "reports" && id !== "tax"));
    items.push(navItem("#/reports/tax", "Tax summary", "", view === "reports" && id === "tax"));
    items.push(h("div", { class: "sidebar-foot" }, sidebarFoot()));
    document.getElementById("sidebar").replaceChildren(...items);
}

function sidebarFoot() {
    const g = S.git;
    const out = [];
    if (g) {
        const bits = [g.branch || "detached"];
        if (g.ahead) bits.push(`${g.ahead} to push`);
        if (g.behind) bits.push(`${g.behind} to pull`);
        if (g.dirty) bits.push(`${g.dirty} uncommitted`);
        if (!g.auto_commit) bits.push("auto-commit off");
        out.push(h("div", { class: "git" }, h("span", null, "git: " + bits.join(" · ")),
            g.upstream ? h("button", { class: "small", onclick: syncRepo }, "Sync") : null));
        if (g.error) out.push(h("div", { class: "git-error" }, g.error));
    }
    out.push(h("a", { href: "#/settings" }, "Settings"));
    return out;
}

async function syncRepo(e) {
    const button = e.target;
    button.disabled = true;
    button.textContent = "Syncing…";
    try {
        const res = await api("POST", "/api/sync");
        toast(res.output || "Up to date");
    } catch (err) {
        showError(err);
    }
    await reload().catch(showError);
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
            h("td", { class: "date" }, d.issue_date || ""),
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
        return [h("button", { onclick: () => go("edit-client", client.id) }, "Edit client"),
                h("button", { class: "primary", onclick: () => newDraft(client.id) }, "+ New invoice")];
    }
    const clients = clientsByRecent().filter(c => !c.archived);
    if (!clients.length) return [];
    const select = h("select", null, clients.map(c => h("option", { value: c.id }, clientName(c.id))));
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
        inv._.signed ? fact("Signature", `${inv.id}.pdf.asc`) : null,
        inv.legacy ? fact("Imported from", `${inv.legacy.commit.slice(0, 10)} “${inv.legacy.subject}”`) : null);

    const left = h("div", null, head, facts,
        h("div", { class: "actions" }, invoiceActions(inv)),
        inv.email_body ? [h("h2", null, "Email text"), h("pre", { class: "email" }, inv.email_body)] : null);

    return h("div", { class: "detail" }, left,
             h("iframe", { class: "pdf", src: pdfUrl(inv.id), title: "Invoice PDF" }));
}

function invoiceActions(inv) {
    const st = inv._.status;
    const out = [];
    if (st === "open" || st === "overdue") {
        out.push(h("button", { class: "primary", onclick: async () => {
            const date = await askDate(`Mark ${inv.number} as paid`, "Payment received on", "Mark paid",
                                       [["Today", S.today], ["Due date", inv.due_date]]);
            if (date) invoiceAction(inv, "status", { status: "paid", paid_date: date });
        } }, "Mark paid…"));
        out.push(h("button", { onclick: () => {
            if (confirm(`Mark ${inv.number} as cancelled?`)) invoiceAction(inv, "status", { status: "cancelled" });
        } }, "Cancel invoice"));
    } else if (st === "paid") {
        out.push(h("button", { onclick: () => invoiceAction(inv, "status", { status: "open" }) }, "Mark unpaid"));
    } else if (st === "cancelled") {
        out.push(h("button", { onclick: () => invoiceAction(inv, "status", { status: "open" }) }, "Reopen"));
    }
    out.push(h("a", { class: "btn", href: pdfUrl(inv.id).replace(/#.*/, ""), target: "_blank" }, "Open PDF"));
    out.push(h("button", { onclick: () => invoiceAction(inv, "sign").then(r => r && toast("Signed")) },
               inv._.signed ? "Re-sign (GPG)" : "Sign (GPG)"));
    out.push(h("button", { onclick: () => invoiceAction(inv, "reveal") }, "Show folder"));
    if (inv.email_body) {
        out.push(h("button", { onclick: () => navigator.clipboard.writeText(inv.email_body)
            .then(() => toast("Email text copied"), showError) }, "Copy email text"));
    }
    out.push(h("button", { onclick: () => newDraft(inv.client, inv.id) }, "Duplicate as draft"));
    out.push(h("button", { class: "danger", onclick: async () => {
        const msg = inv.legacy
            ? `Unlock ${inv.number}? This was imported from LaTeX; re-issuing renders it with the new template.`
            : `Unlock ${inv.number} for editing? Its PDF is removed until you issue it again (with the same number).`;
        if (!confirm(msg)) return;
        const draft = await invoiceAction(inv, "unlock");
        if (draft) go("draft", draft.id);
    } }, "Unlock for editing"));
    return out;
}

async function invoiceAction(inv, action, body = {}) {
    try {
        const res = await api("POST", `/api/invoices/${encodeURIComponent(inv.id)}/${action}`, body);
        await reload();
        return res;
    } catch (e) {
        showError(e);
    }
}

// Modal with one button per choice; resolves to the chosen value, or null.
function choose(title, message, choices) {
    return new Promise(resolve => {
        const dlg = h("dialog", { class: "modal" },
            h("form", { method: "dialog" },
                h("h3", null, title),
                h("p", null, message),
                h("div", { class: "actions" }, choices.map(([value, label], i) =>
                    h("button", { value, class: i === 0 ? "primary" : null }, label)))));
        dlg.addEventListener("close", () => {
            resolve(dlg.returnValue || null);
            dlg.remove();
        });
        document.body.append(dlg);
        dlg.showModal();
    });
}

// Save a form, asking what to do if the object was changed elsewhere meanwhile.
async function saveForm(path, obj) {
    try {
        return await api("PUT", path, obj);
    } catch (err) {
        if (err.status !== 409) throw err;
        const choice = await choose("Changed elsewhere",
            `This was ${err.data.deleted ? "deleted" : "saved"} ${changedBy(err)} after you opened this form.`,
            [["reload", "Discard my changes"], ["overwrite", "Save mine anyway"]]);
        if (choice !== "overwrite") {
            await reload();
            return null;
        }
        return api("PUT", path, { ...obj, base_revision: err.data.current_revision });
    }
}

// Modal date picker; resolves to an ISO date, or null if cancelled.
function askDate(title, label, confirmLabel, presets = []) {
    return new Promise(resolve => {
        const input = h("input", { type: "date", value: presets.length ? presets[0][1] : S.today, required: true });
        const dlg = h("dialog", { class: "modal" },
            h("form", { method: "dialog" },
                h("h3", null, title),
                h("label", { class: "field" }, h("span", null, label), input),
                presets.length ? h("div", { class: "presets" }, presets.filter(([, v]) => v).map(([name, v]) =>
                    h("button", { type: "button", class: "small", onclick: () => { input.value = v; } },
                      `${name} (${v})`))) : null,
                h("div", { class: "actions" },
                    h("button", { value: "cancel", formnovalidate: true }, "Cancel"),
                    h("button", { class: "primary", value: "ok" }, confirmLabel))));
        dlg.addEventListener("close", () => {
            resolve(dlg.returnValue === "ok" && input.value ? input.value : null);
            dlg.remove();
        });
        document.body.append(dlg);
        dlg.showModal();
        input.focus();
    });
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
    flush(old)
        .then(() => api("POST", `/api/drafts/${encodeURIComponent(old.id)}/commit`))
        .then(() => reload())
        .catch(e => { if (!/no such draft/.test(e.message)) showError(e); });
}

function draftView(id) {
    const stored = S.drafts.find(d => d.id === id);
    if (!stored) return h("div", { class: "empty" }, "This draft no longer exists.");
    if (ed && ed.id === id) return ed.root;

    const draft = structuredClone(stored);
    delete draft._;
    ed = { id, draft, dirty: false, timer: null, previewSeq: 0, previewUrl: null, saved: stored,
           base: revisionOf(stored) };

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
    } }, clientsByRecent()
        .filter(c => !c.archived || c.id === draft.client)
        .map(c => h("option", { value: c.id, selected: c.id === draft.client }, clientName(c.id))));

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

function issueButton(saved) {
    const problems = saved._.problems || [];
    return [h("button", { class: "primary", disabled: problems.length > 0, onclick: () => issueDraft(ed) },
              `Issue as ${saved._.next_number}`)];
}

async function issueDraft(e) {
    try {
        await flush(e);
        if (ed !== e || e.dirty) return;
        const saved = e.saved;
        if (saved._.problems.length) return;
        const client = clientName(e.draft.client);
        const cur = (S.clients[e.draft.client] || {}).currency || "EUR";
        let msg = `Issue invoice ${saved._.next_number} to ${client} over ${money(saved._.gross, cur)}?`;
        const { warnings } = await api("GET", "/api/sync-check");
        if (warnings.length) msg += "\n\nWarning: " + warnings.join("\nWarning: ");
        if (e.draft.issue_date !== S.today) msg += `\n\nNote: the invoice date is ${e.draft.issue_date}, not today.`;
        if (!confirm(msg)) return;
        e.dirty = false;
        const inv = await api("POST", `/api/drafts/${encodeURIComponent(e.id)}/issue`);
        ed = null;
        await reload();
        go("invoice", inv.id);
        toast(`Issued ${inv.number}`);
    } catch (err) {
        showError(err);
    }
}

async function flush(e) {
    clearTimeout(e.timer);
    if (!e.dirty || e.conflict) return;
    e.dirty = false;
    if (ed === e) setEdStatus("Saving…");
    let saved;
    try {
        saved = await api("PUT", `/api/drafts/${encodeURIComponent(e.id)}`,
                          { ...payload(e.draft), base_revision: e.base });
    } catch (err) {
        e.dirty = true;
        if (err.status === 409) return draftConflict(e, err);
        if (err.status === 404) {
            e.dirty = false;
            toast("This draft was issued or deleted on another machine.", "error");
            if (ed === e) ed = null;
            return reload();
        }
        throw err;
    }
    e.base = revisionOf(saved);
    const idx = S.drafts.findIndex(d => d.id === e.id);
    if (idx >= 0) S.drafts[idx] = saved;
    if (ed !== e) return;
    updateEdInfo(saved);
    setEdStatus(e.dirty ? "Unsaved changes" : "Saved");
    refreshPreview(e);
}

// The draft was saved elsewhere while this tab had unsaved edits.
async function draftConflict(e, err) {
    e.conflict = true;
    if (ed === e) setEdStatus("Changed elsewhere");
    const choice = await choose("This draft was changed elsewhere",
        `It was saved ${changedBy(err)} while you had unsaved edits here.`,
        [["theirs", "Load that version"], ["mine", "Keep my edits"]]);
    e.conflict = false;
    if (choice === "mine") {
        e.base = err.data.current_revision;
        return flush(e);
    }
    e.dirty = false;
    if (ed === e) ed = null;
    return reload();
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

/* Client and settings forms */

// Each field: [key, label, type, extra]. Types: text, lines, area, number, select, check.
function formFields(obj, fields) {
    return fields.map(([key, label, type, extra = {}]) => {
        const value = obj[key];
        let input;
        if (type === "lines" || type === "area") {
            input = h("textarea", { rows: extra.rows || 3, placeholder: extra.placeholder || "",
                value: Array.isArray(value) ? value.join("\n") : (value || ""),
                oninput: e => { obj[key] = type === "lines" ? e.target.value.split("\n") : e.target.value; } });
        } else if (type === "select") {
            input = h("select", { onchange: e => { obj[key] = e.target.value; } },
                extra.options.map(([v, l]) => h("option", { value: v, selected: v === (value || extra.default) }, l)));
        } else if (type === "country") {
            // Name first, so that typing a name jumps to it in the native dropdown.
            const option = code => h("option", { value: code, selected: code === value },
                                     `${countryName(code)} ${flag(code)}`);
            const used = [...new Set(Object.values(S.clients).map(c => c.country))]
                .filter(c => COUNTRY_CODES.includes(c)).sort();
            const all = [...COUNTRY_CODES].sort((a, b) => countryName(a).localeCompare(countryName(b)));
            input = h("select", { onchange: e => { obj[key] = e.target.value; } },
                h("option", { value: "", selected: !value }, "—"),
                value && !COUNTRY_CODES.includes(value) ? h("option", { value, selected: true }, value) : null,
                used.length ? h("optgroup", { label: "Your clients" }, used.map(option)) : null,
                h("optgroup", { label: "All countries" }, all.map(option)));
        } else if (type === "check") {
            return h("label", { class: "field check wide" },
                h("input", { type: "checkbox", checked: !!value, onchange: e => { obj[key] = e.target.checked; } }),
                h("span", null, label));
        } else {
            input = h("input", { type: type === "number" ? "number" : "text", value: value ?? "",
                placeholder: extra.placeholder || "", oninput: e => { obj[key] = e.target.value; } });
        }
        return h("label", { class: `field ${extra.wide ? "wide" : ""}` },
                 h("span", null, label), input, extra.hint ? h("small", { class: "muted" }, extra.hint) : null);
    });
}

function clientForm(id) {
    const isNew = !id;
    const client = isNew ? { tax_scheme: "eu_reverse_charge", currency: "EUR" } : structuredClone(S.clients[id] || {});
    if (!isNew && !S.clients[id]) return h("div", { class: "empty" }, `No client ${id}.`);
    const obj = { ...client, id: id || "", base_revision: revisionOf(client) };
    const schemes = Object.entries(S.meta.tax_schemes).map(([k, v]) => [k, `${v.label} (${v.rate}% VAT)`]);
    const units = Object.entries(S.meta.units).map(([k, [one]]) => [k, one || "unit"]);
    const noteHint = () => (S.meta.tax_schemes[obj.tax_scheme || "eu_reverse_charge"] || {}).note;

    const fields = [
        isNew ? ["id", "Identifier (file name, cannot be changed)", "text", { placeholder: "e.g. acme" }] : null,
        ["name", "Name (as printed on invoices)", "text", { wide: true }],
        ["short_name", "Short name (optional, shown in this app)", "text", { placeholder: "e.g. SPI Inc" }],
        ["code", "Code (invoice number prefix)", "text", { placeholder: "e.g. ACM" }],
        ["country", "Country", "country"],
        ["address", "Address (one line per row, include the country if abroad)", "lines", { wide: true }],
        ["vat_id", "VAT ID", "text"],
        ["buyer_reference", "Buyer reference / Leitweg-ID", "text", { hint: "Only needed for e-invoicing" }],
        ["tax_scheme", "Tax treatment", "select", { options: schemes, default: "eu_reverse_charge", wide: true }],
        ["tax_note", "Tax notice on invoice", "area", { wide: true, rows: 2, placeholder: noteHint(),
            hint: "Leave empty to use the default text shown." }],
        ["due_days", "Payment term (days)", "number", { placeholder: String(S.settings.due_days) }],
        ["currency", "Currency", "text"],
        ["title", "Default invoice title", "text", { placeholder: "e.g. Consulting" }],
        ["sender_email", "Your email on invoices (override)", "text", { placeholder: S.settings.sender.email }],
        ["rate", "Default price for new rows", "text"],
        ["rate_unit", "Default unit for new rows", "select", { options: units, default: "C62" }],
        ["archived", "Archived (hide from new invoices)", "check"],
    ].filter(Boolean);

    const save = async () => {
        const cid = (obj.id || "").trim();
        if (!cid) return toast("Please enter an identifier", "error");
        try {
            if (!await saveForm(`/api/clients/${encodeURIComponent(cid)}`, obj)) return;
            await reload();
            go("client", cid);
            toast("Client saved");
        } catch (e) {
            showError(e);
        }
    };
    return h("div", { class: "form narrow" },
        h("div", { class: "page-head" }, h("h1", null, isNew ? "New client" : `Edit ${client.name}`)),
        h("div", { class: "grid" }, formFields(obj, fields)),
        h("div", { class: "actions" }, h("button", { class: "primary", onclick: save }, "Save"),
          h("button", { onclick: () => history.back() }, "Cancel")));
}

function settingsForm() {
    const settings = structuredClone(S.settings);
    settings.base_revision = revisionOf(S.settings);
    const sender = settings.sender;
    const save = async () => {
        try {
            if (!await saveForm("/api/settings", settings)) return;
            await reload();
            toast("Settings saved");
        } catch (e) {
            showError(e);
        }
    };
    return h("div", { class: "form narrow" },
        h("div", { class: "page-head" }, h("h1", null, "Settings")),
        h("h2", null, "Your business"),
        h("div", { class: "grid" }, formFields(sender, [
            ["name", "Business name", "text", { wide: true }],
            ["address", "Address (one line per row)", "lines", { wide: true }],
            ["email", "Email", "text"],
            ["website", "Website", "text"],
            ["vat_id", "VAT ID (USt-IdNr.)", "text"],
            ["tax_number", "Tax number (Steuernummer)", "text"],
            ["iban", "IBAN", "text"],
            ["bic", "BIC", "text"],
        ])),
        h("h2", null, "Invoices"),
        h("div", { class: "grid" }, formFields(settings, [
            ["tagline", "Tagline below the logo", "text", { wide: true }],
            ["number_format", "Number format", "text",
             { hint: "Placeholders: {code}, {year}, {seq:03}" }],
            ["due_days", "Default payment term (days)", "number"],
            ["gpg_key", "GPG key for signing", "text", { placeholder: "default key" }],
            ["auto_commit", "Commit every change to git (if the data directory is a git repository)", "check"],
        ])),
        h("div", { class: "actions" }, h("button", { class: "primary", onclick: save }, "Save")));
}

reload().catch(showError);
