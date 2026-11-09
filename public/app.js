// Shared helpers for ProofPay pages.
export const qs = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const money = (amount, currency) =>
  `${currency} ${Number(amount).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const STATUS = {
  awaiting_funding: { label: "Waiting for client to fund", tone: "" },
  funded: { label: "Funded, money on hold", tone: "held" },
  submitted: { label: "Work submitted", tone: "working" },
  verifying: { label: "Checking the work", tone: "working" },
  release_scheduled: { label: "Passed, releasing soon", tone: "held" },
  changes_requested: { label: "Changes needed", tone: "alert" },
  partial_offered: { label: "Partial release offered", tone: "held" },
  needs_review: { label: "Needs a person to review", tone: "alert" },
  disputed: { label: "Client objected", tone: "alert" },
  released: { label: "Paid", tone: "released" },
  partially_released: { label: "Partly paid", tone: "released" },
  cancelled: { label: "Cancelled, hold returned", tone: "" },
};

export const statusPill = (status) => {
  const s = STATUS[status] || { label: status, tone: "" };
  return `<span class="status ${s.tone}">${esc(s.label)}</span>`;
};

// Where the milestone's money is right now: held, released to freelancer, returned to client.
export function moneySplit(m) {
  const captured = (m.paypal?.captures || []).reduce((sum, c) => sum + Number(c.amount), 0);
  const funded = Boolean(m.paypal?.authorizationId);
  if (m.status === "cancelled") return { held: 0, released: 0, returned: funded ? m.amount : 0, pending: funded ? 0 : m.amount };
  if (captured > 0) return { held: 0, released: captured, returned: m.amount - captured, pending: 0 };
  if (funded) return { held: m.amount, released: 0, returned: 0, pending: 0 };
  return { held: 0, released: 0, returned: 0, pending: m.amount };
}

export function meter(m, { small = false } = {}) {
  const s = moneySplit(m);
  const pct = (v) => `${((v / m.amount) * 100).toFixed(2)}%`;
  return `<div class="meter ${small ? "small" : ""}" role="img" aria-label="${esc(meterLabel(m, s))}">
    <span class="released" style="width:${pct(s.released)}"></span>
    <span class="held" style="width:${pct(s.held)}"></span>
    <span class="returned" style="width:${pct(s.returned)}"></span>
    <span class="pending" style="width:${pct(s.pending)}"></span>
  </div>`;
}

export function meterLabel(m, s = moneySplit(m)) {
  const parts = [];
  if (s.held) parts.push(`${money(s.held, m.currency)} on hold`);
  if (s.released) parts.push(`${money(s.released, m.currency)} paid to freelancer`);
  if (s.returned) parts.push(`${money(s.returned, m.currency)} returned to client`);
  if (s.pending) parts.push(`${money(s.pending, m.currency)} not funded yet`);
  return parts.join(", ");
}

export function legend(m) {
  const s = moneySplit(m);
  const items = [];
  if (s.held) items.push(`<span class="held"><i></i>${money(s.held, m.currency)} on hold with PayPal</span>`);
  if (s.released) items.push(`<span class="released"><i></i>${money(s.released, m.currency)} paid to freelancer</span>`);
  if (s.returned) items.push(`<span class="returned"><i></i>${money(s.returned, m.currency)} returned to client</span>`);
  if (s.pending) items.push(`<span>Not funded yet</span>`);
  return `<div class="meter-legend">${items.join("")}</div>`;
}

export function criteriaResults(m) {
  const v = m.verifications?.at(-1);
  const byId = new Map((v?.results || []).map((r) => [r.criterionId, r]));
  const min = 0.7;
  return `<ul class="criteria">${m.criteria
    .map((c) => {
      const r = byId.get(c.id);
      let cls = "";
      let mark = "";
      if (r) {
        if (r.confidence < min) [cls, mark] = ["unsure", "?"];
        else if (r.pass) [cls, mark] = ["pass", "✓"];
        else [cls, mark] = ["fail", "✕"];
      }
      return `<li class="${cls}"><span class="mark" aria-hidden="true">${mark}</span><div>
        <div>${esc(c.text)}</div>
        ${r ? `<div class="evidence">${esc(r.evidence)}</div><div class="meta">${esc(r.source)} · ${Math.round(r.confidence * 100)}% sure</div>` : ""}
      </div></li>`;
    })
    .join("")}</ul>`;
}

export function screenshots(m) {
  const v = m.verifications?.at(-1);
  if (!v?.screenshots?.length) return "";
  return `<div class="shots">${v.screenshots
    .map((s) => `<figure><a href="${esc(s.path)}" target="_blank" rel="noopener"><img src="${esc(s.path)}" alt="${esc(s.label)} screenshot of the submitted work" loading="lazy"></a><figcaption>${s.label === "mobile" ? "Phone, 390px wide" : "Desktop, 1280px wide"}</figcaption></figure>`)
    .join("")}</div>`;
}

const TRACE_TYPES = { paypal: "PayPal", ai: "AI", policy: "Policy", human: "People", security: "Security", state: "Status", evidence: "Evidence", milestone: "Milestone", error: "Errors" };

export function traceView(m, filter = "all") {
  const items = m.trace.filter((t) => filter === "all" || t.type === filter);
  const types = ["all", ...Object.keys(TRACE_TYPES).filter((k) => m.trace.some((t) => t.type === k))];
  const buttons = types
    .map((t) => `<button type="button" data-filter="${t}" aria-pressed="${t === filter}">${t === "all" ? "Everything" : TRACE_TYPES[t]}</button>`)
    .join("");
  const list = items
    .map(
      (t) => `<li class="t-${t.type}">
        <div class="who">${new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${esc(TRACE_TYPES[t.type] || t.type)} · ${esc(t.actor)}</div>
        <div class="what">${esc(t.type === "state" && t.data ? `${STATUS[t.data.from]?.label || t.data.from} to ${STATUS[t.data.to]?.label || t.data.to}` : t.summary)}</div>
        ${t.data && t.type !== "state" ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(t.data, null, 2))}</pre></details>` : ""}
      </li>`,
    )
    .join("");
  return `<div class="trace-filter" role="group" aria-label="Filter the trace">${buttons}</div><ol class="trace">${list}</ol>`;
}

export function bindTraceFilter(container, getMilestone) {
  container.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    container.dataset.filter = b.dataset.filter;
    container.innerHTML = traceView(getMilestone(), b.dataset.filter);
  });
}

export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "any moment now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h >= 1) return `in ${h}h ${String(mm).padStart(2, "0")}m`;
  return `in ${mm}:${String(ss).padStart(2, "0")}`;
}

export async function topbar(active) {
  const cfg = await api("GET", "/api/config").catch(() => ({}));
  const el = document.createElement("header");
  el.className = "topbar";
  el.innerHTML = `<a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>ProofPay</a>
    <nav>
      <a href="/" ${active === "dash" ? 'aria-current="page"' : ""}>Milestones</a>
      <a href="/new" ${active === "new" ? 'aria-current="page"' : ""}>New milestone</a>
      <a class="optional" href="/board" ${active === "board" ? 'aria-current="page"' : ""}>Job board demo</a>
      <span class="mode-pill" title="PayPal mode and AI provider">${cfg.paypalMode === "mock" ? "Simulated PayPal" : `PayPal ${esc(cfg.paypalMode || "")}`}, ${cfg.aiProvider?.startsWith("mock") ? "rule-based checker" : esc(cfg.aiProvider || "")}</span>
    </nav>`;
  document.body.prepend(el);
  return cfg;
}

export const keyFromUrl = () => new URLSearchParams(location.search).get("k");
export const idFromPath = () => location.pathname.split("/").filter(Boolean).at(-1);
