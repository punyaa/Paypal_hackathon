// End-to-end test against the real PayPal sandbox and the configured AI provider.
// Funds milestones through sandbox guest card checkout, then runs four scenarios.
// Usage: OBJECTION_WINDOW_SECONDS=30 npm start   (in another terminal)
//        node scripts/sandbox-e2e.cjs http://localhost:3000
const fund = require("./sandbox-fund.cjs");
const B = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (link) => new URL(link, B).searchParams.get("k");

async function call(method, path, body) {
  const res = await fetch(B + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}
async function waitFor(m, statuses, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = await call("GET", `/api/milestones/${m.id}?k=${m.fk}`);
    if (statuses.includes(x.status)) return x;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${statuses}`);
}
async function create(title, amount) {
  const m = await call("POST", "/api/milestones", {
    title, amount, currency: "SGD",
    criteria: ["Has a main heading that names the business", "Has a pricing section with at least three priced items", "Has a contact form with name, email and message fields", "Works on a phone-sized screen without horizontal scrolling"],
    freelancer: { name: "Arjun Mehta" }, client: { name: "Kopi & Crumbs Pte Ltd" },
  });
  const ctx = { id: m.id, ck: keyOf(m.clientLink), fk: keyOf(m.freelancerLink), clientLink: m.clientLink };
  const r = await fund(B, m.clientLink);
  if (!r.popupClosed) throw new Error("PayPal checkout did not complete");
  const funded = await waitFor(ctx, ["funded"], 30000);
  console.log(`  funded: authorization ${funded.paypal.authorizationId}, ${funded.currency} ${funded.paypal.authorizedAmount} on hold`);
  return ctx;
}
async function submit(m, sample) {
  const t = Date.now();
  await call("POST", `/api/milestones/${m.id}/submit?k=${m.fk}`, { url: `${B}/samples/kopi-crumbs/${sample}/` });
  const x = await waitFor(m, ["release_scheduled", "changes_requested", "needs_review"]);
  console.log(`  ${sample}: ${x.status} (${Math.round(x.decision.score * 100)}% passed, ${((Date.now() - t) / 1000).toFixed(0)}s)`);
  return x;
}
const captures = (x) => x.paypal.captures.map((c) => `${c.id} ${x.currency} ${c.amount}${c.breakdown?.paypal_fee ? ` (fee ${c.breakdown.paypal_fee.value}, net ${c.breakdown.net_amount.value})` : ""}`).join(", ");
const paypalCalls = (x) => x.trace.filter((t) => t.type === "paypal").map((t) => `    ${t.summary}${t.data?.debugId ? `  debug ${t.data.debugId}` : ""}`).join("\n");

(async () => {
  const cfg = await call("GET", "/api/config");
  console.log(`ProofPay ${B} | PayPal ${cfg.paypalMode} | AI ${cfg.aiProvider} | window ${cfg.objectionWindowSeconds}s`);

  console.log("\nA) Partial work, fixed, released automatically after the objection window");
  const a = await create("E2E A: fix then full release", 1200);
  await submit(a, "v1");
  await submit(a, "v2");
  let x = await waitFor(a, ["released"], (cfg.objectionWindowSeconds + 60) * 1000);
  console.log(`  released: ${captures(x)}\n${paypalCalls(x)}`);

  console.log("\nB) Partial release offered by the freelancer, approved by the client");
  const b = await create("E2E B: partial release", 1200);
  await submit(b, "v1");
  await call("POST", `/api/milestones/${b.id}/offer-partial?k=${b.fk}`);
  x = await call("POST", `/api/milestones/${b.id}/approve?k=${b.ck}`);
  console.log(`  ${x.status}: ${captures(x)}; rest of the hold released to the client`);

  console.log("\nC) Prompt injection, then reviewer returns the money");
  const c = await create("E2E C: injection", 260);
  await submit(c, "sneaky");
  x = await call("POST", `/api/milestones/${c.id}/resolve?k=${c.fk}`, { action: "refund" });
  console.log(`  ${x.status}: ${x.trace.filter((t) => t.type === "paypal").at(-1).summary}`);

  console.log("\nD) Freelancer cancels a funded milestone");
  const d = await create("E2E D: cancel", 180);
  x = await call("POST", `/api/milestones/${d.id}/cancel?k=${d.fk}`);
  console.log(`  ${x.status}: ${x.trace.filter((t) => t.type === "paypal").at(-1).summary}`);
  console.log("\nAll scenarios passed.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
