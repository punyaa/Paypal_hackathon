// End-to-end smoke test against a running ProofPay server (mock or sandbox PayPal).
// Usage: node scripts/smoke.js [baseUrl]
// Runs three scenarios with the sample sites: partial -> fix -> full release,
// a partial release accepted by the client, and a prompt-injection attempt.
const B = process.argv[2] || process.env.BASE_URL || "http://localhost:3000";

async function call(method, path, body) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}

const keyOf = (link) => new URL(link, B).searchParams.get("k");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id, k, statuses, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = await call("GET", `/api/milestones/${id}?k=${k}`);
    if (statuses.includes(m.status)) return m;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${statuses.join("/")}`);
}

async function fundedMilestone(title) {
  const m = await call("POST", "/api/milestones", {
    title,
    amount: 1200,
    currency: "SGD",
    criteria: [
      "Has a main heading that names the business",
      "Has a pricing section with at least three priced items",
      "Has a contact form with name, email and message fields",
      "Works on a phone-sized screen without horizontal scrolling",
    ],
    freelancer: { name: "Arjun (Bangalore)", country: "IN" },
    client: { name: "Kopi & Crumbs Pte Ltd" },
  });
  const ck = keyOf(m.clientLink);
  const fk = keyOf(m.freelancerLink);
  const config = await call("GET", "/api/config");
  if (config.paypalMode !== "mock") {
    console.log(`  Sandbox mode: approve this milestone in the browser at ${B}${m.clientLink}`);
    await waitFor(m.id, ck, ["funded"], 300_000);
  } else {
    const order = await call("POST", `/api/milestones/${m.id}/order?k=${ck}`);
    await call("POST", `/api/milestones/${m.id}/authorize?k=${ck}`, { orderId: order.orderId });
  }
  return { id: m.id, ck, fk };
}

async function submit(ctx, sample) {
  await call("POST", `/api/milestones/${ctx.id}/submit?k=${ctx.fk}`, { url: `${B}/samples/kopi-crumbs/${sample}/` });
  return waitFor(ctx.id, ctx.fk, ["release_scheduled", "changes_requested", "needs_review"]);
}

const show = (label, m) =>
  console.log(`  ${label}: ${m.status}${m.decision ? ` (${m.decision.action}, score ${Math.round(m.decision.score * 100)}%)` : ""}`);

console.log(`ProofPay smoke test against ${B}`);

console.log("1) Partial work, then fixed, then released after the objection window");
let a = await fundedMilestone("Smoke: partial then fixed");
show("v1 verified", await submit(a, "v1"));
show("v2 verified", await submit(a, "v2"));
const released = await waitFor(a.id, a.fk, ["released"], 120_000);
show("after window", released);

console.log("2) Partial release offered by the freelancer, approved by the client");
let b = await fundedMilestone("Smoke: partial release");
show("v1 verified", await submit(b, "v1"));
show("offered", await call("POST", `/api/milestones/${b.id}/offer-partial?k=${b.fk}`));
const partial = await call("POST", `/api/milestones/${b.id}/approve?k=${b.ck}`);
show("approved", partial);
console.log(`  captured ${partial.currency} ${partial.paypal.captures[0].amount}`);

console.log("3) Prompt injection hidden in the page");
let c = await fundedMilestone("Smoke: injection");
const inj = await submit(c, "sneaky");
show("verified", inj);
console.log(`  security events: ${inj.trace.filter((t) => t.type === "security").length}`);

console.log("Done.");
