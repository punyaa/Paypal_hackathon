import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/lib/policy.js";
import { MilestoneService } from "../src/milestones.js";
import { Store } from "../src/store.js";
import { MockPayPalClient } from "../src/paypal/mock.js";

const criteria = [
  { id: "c1", text: "A", weight: 1 },
  { id: "c2", text: "B", weight: 1 },
  { id: "c3", text: "C", weight: 1 },
  { id: "c4", text: "D", weight: 1 },
];
const r = (id, pass, confidence = 0.9) => ({ criterionId: id, pass, confidence, evidence: "" });

test("policy: all pass -> auto release", () => {
  const d = decide({ criteria, results: criteria.map((c) => r(c.id, true)), amount: 1200 });
  assert.equal(d.action, "auto_release");
  assert.equal(d.score, 1);
});

test("policy: 3 of 4 -> offer partial at 75%", () => {
  const d = decide({ criteria, results: [r("c1", true), r("c2", true), r("c3", true), r("c4", false)], amount: 1200 });
  assert.equal(d.action, "offer_partial");
  assert.equal(d.partialAmount, 900);
});

test("policy: low confidence -> human review, even if marked pass", () => {
  const d = decide({ criteria, results: [r("c1", true), r("c2", true), r("c3", true), r("c4", true, 0.4)], amount: 1200 });
  assert.equal(d.action, "human_review");
  assert.deepEqual(d.lowConfidence, ["c4"]);
});

test("policy: under half -> request changes, no money", () => {
  const d = decide({ criteria, results: [r("c1", true), r("c2", false), r("c3", false), r("c4", false)], amount: 1200 });
  assert.equal(d.action, "request_changes");
});

test("policy: missing result counts as low confidence", () => {
  const d = decide({ criteria, results: [r("c1", true)], amount: 100 });
  assert.equal(d.action, "human_review");
});

function setup({ results }) {
  let clock = new Date("2026-11-09T10:00:00Z");
  const svc = new MilestoneService({
    store: new Store(null),
    paypal: new MockPayPalClient(),
    ai: {
      name: "stub",
      draftCriteria: async () => ["Has a pricing section", "Works on mobile"],
      verify: async ({ milestone }) => results(milestone),
    },
    verifier: { collect: async (url) => ({ method: "stub", url, text: "hello", screenshots: [] }) },
    config: { objectionWindowSeconds: 60, defaultCurrency: "SGD", baseUrl: "http://x", policy: { minConfidence: 0.7, partialThreshold: 0.5 } },
    now: () => clock,
  });
  return { svc, advance: (s) => (clock = new Date(clock.getTime() + s * 1000)) };
}

async function funded(svc, extra = {}) {
  const m = await svc.create({ title: "Landing page", amount: 1200, currency: "SGD", criteria: ["A", "B", "C", "D"], ...extra });
  const order = await svc.createOrder(m.id);
  return svc.authorize(m.id, order.orderId);
}

test("happy path: fund, submit, verify all pass, auto release after window", async () => {
  const { svc, advance } = setup({ results: (m) => m.criteria.map((c) => r(c.id, true)) });
  let m = await funded(svc);
  assert.equal(m.status, "funded");
  await svc.submit(m.id, { url: "https://example.com" });
  m = await svc.verify(m.id);
  assert.equal(m.status, "release_scheduled");
  assert.equal((await svc.tick()).length, 0, "nothing released before the window closes");
  advance(61);
  const [released] = await svc.tick();
  assert.equal(released.status, "released");
  assert.equal(released.paypal.captures[0].amount, 1200);
  assert.ok(released.trace.some((t) => t.type === "paypal" && t.summary.includes("/capture")));
});

test("partial path: 3 of 4, freelancer offers partial, client approves early", async () => {
  const { svc } = setup({ results: () => [r("c1", true), r("c2", true), r("c3", true), r("c4", false)] });
  let m = await funded(svc);
  await svc.submit(m.id, { url: "https://example.com" });
  m = await svc.verify(m.id);
  assert.equal(m.status, "changes_requested");
  m = await svc.offerPartial(m.id);
  assert.equal(m.status, "partial_offered");
  m = await svc.approve(m.id);
  assert.equal(m.status, "partially_released");
  assert.equal(m.paypal.captures[0].amount, 900);
});

test("resubmit after changes, then full pass", async () => {
  let attempt = 0;
  const { svc } = setup({
    results: () => (++attempt === 1 ? [r("c1", true), r("c2", true), r("c3", true), r("c4", false)] : ["c1", "c2", "c3", "c4"].map((id) => r(id, true))),
  });
  let m = await funded(svc);
  await svc.submit(m.id, { url: "https://example.com/v1" });
  await svc.verify(m.id);
  await svc.submit(m.id, { url: "https://example.com/v2" });
  m = await svc.verify(m.id);
  assert.equal(m.status, "release_scheduled");
  assert.equal(m.verifications.length, 2);
});

test("objection freezes money; reviewer refunds by voiding the hold", async () => {
  const { svc, advance } = setup({ results: (m) => m.criteria.map((c) => r(c.id, true)) });
  let m = await funded(svc);
  await svc.submit(m.id, { url: "https://example.com" });
  await svc.verify(m.id);
  m = await svc.object(m.id, "Contact form does not send emails");
  assert.equal(m.status, "disputed");
  advance(3600);
  assert.equal((await svc.tick()).length, 0, "disputed milestones are never auto-released");
  m = await svc.resolve(m.id, { action: "refund" });
  assert.equal(m.status, "cancelled");
  assert.ok(m.trace.some((t) => t.summary.includes("/void")));
});

test("guards: client cannot cancel a funded milestone before the due date", async () => {
  const { svc } = setup({ results: () => [] });
  const m = await funded(svc, { dueDate: "2026-12-01T00:00:00Z" });
  await assert.rejects(svc.cancel(m.id, "client"), /only if the due date passes/);
  const cancelled = await svc.cancel(m.id, "freelancer");
  assert.equal(cancelled.status, "cancelled");
});

test("guards: no double capture, cannot submit before funding", async () => {
  const { svc } = setup({ results: (m) => m.criteria.map((c) => r(c.id, true)) });
  const unfunded = await svc.create({ title: "X", amount: 10, criteria: ["A"] });
  await assert.rejects(svc.submit(unfunded.id, { url: "https://e.com" }), /Cannot submit/);
  let m = await funded(svc);
  await svc.submit(m.id, { url: "https://example.com" });
  await svc.verify(m.id);
  m = await svc.approve(m.id);
  await assert.rejects(svc.capture(m, 10, "x"), /already captured/);
});

test("criteria are drafted by the AI when none are given", async () => {
  const { svc } = setup({ results: () => [] });
  const m = await svc.create({ title: "Site", amount: 100, description: "Build a landing page for my bakery" });
  assert.equal(m.criteria.length, 2);
  assert.ok(m.trace.some((t) => t.type === "ai"));
});
