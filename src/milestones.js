// Milestone service: state machine, money movement and the trace.
import crypto from "node:crypto";
import { decide } from "./lib/policy.js";

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newId = (n = 8) => crypto.randomBytes(n).toString("base64url");
const round2 = (n) => Math.round(n * 100) / 100;

// Which statuses allow which actions.
const CAN = {
  createOrder: ["awaiting_funding"],
  authorize: ["awaiting_funding"],
  submit: ["funded", "changes_requested"],
  approve: ["release_scheduled", "partial_offered"],
  object: ["release_scheduled", "partial_offered"],
  offerPartial: ["changes_requested"],
  resolve: ["disputed", "needs_review"],
};

export const OPEN_STATUSES = [
  "awaiting_funding",
  "funded",
  "submitted",
  "verifying",
  "release_scheduled",
  "changes_requested",
  "partial_offered",
  "needs_review",
  "disputed",
];

export class MilestoneService {
  constructor({ store, paypal, ai, verifier, config, now = () => new Date() }) {
    this.store = store;
    this.paypal = paypal;
    this.ai = ai;
    this.verifier = verifier;
    this.config = config;
    this.now = now;
  }

  // ---------- helpers ----------

  get(id) {
    const m = this.store.get(id);
    if (!m) throw new AppError(404, "Milestone not found");
    return m;
  }

  trace(m, type, summary, data = undefined, actor = "system") {
    m.trace.push({ at: this.now().toISOString(), type, actor, summary, data });
  }

  paypalLog(m) {
    return (call) => {
      const label = `${call.method} ${call.path} -> ${call.status}${call.mock ? " (mock)" : ""}`;
      this.trace(m, "paypal", label, call, "paypal");
    };
  }

  expect(m, action) {
    if (!CAN[action].includes(m.status)) {
      throw new AppError(409, `Cannot ${action} while the milestone is ${m.status.replace(/_/g, " ")}`);
    }
  }

  setStatus(m, status, actor = "system") {
    const from = m.status;
    m.status = status;
    this.trace(m, "state", `${from} -> ${status}`, { from, to: status }, actor);
  }

  windowEndsAt() {
    return new Date(this.now().getTime() + this.config.objectionWindowSeconds * 1000).toISOString();
  }

  // ---------- create ----------

  async draftCriteria(description) {
    if (!description || description.trim().length < 10) throw new AppError(400, "Describe the work in a sentence or two");
    return this.ai.draftCriteria(description);
  }

  async create(input) {
    const title = String(input.title || "").trim();
    const amount = round2(Number(input.amount));
    const currency = String(input.currency || this.config.defaultCurrency).toUpperCase();
    if (!title) throw new AppError(400, "Title is required");
    if (!(amount > 0)) throw new AppError(400, "Amount must be greater than zero");
    if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(400, "Currency must be a 3-letter code");

    let criteria = Array.isArray(input.criteria) ? input.criteria : [];
    criteria = criteria
      .map((c) => (typeof c === "string" ? { text: c } : c))
      .filter((c) => c && String(c.text || "").trim())
      .map((c, i) => ({ id: `c${i + 1}`, text: String(c.text).trim(), weight: Number(c.weight) > 0 ? Number(c.weight) : 1 }));

    const m = {
      id: newId(6),
      title,
      description: String(input.description || "").trim(),
      amount,
      currency,
      freelancer: { name: input.freelancer?.name || "Freelancer", email: input.freelancer?.email || "", country: input.freelancer?.country || "" },
      client: { name: input.client?.name || "Client", email: input.client?.email || "" },
      dueDate: input.dueDate || null,
      criteria,
      status: "awaiting_funding",
      clientKey: newId(9),
      freelancerKey: newId(9),
      source: input.source || "direct",
      createdAt: this.now().toISOString(),
      paypal: { orderId: null, authorizationId: null, captures: [] },
      submissions: [],
      verifications: [],
      decision: null,
      releaseAt: null,
      partialOffer: null,
      objection: null,
      trace: [],
    };

    if (!m.criteria.length) {
      if (!m.description) throw new AppError(400, "Add acceptance criteria or a description to draft them from");
      const drafted = await this.ai.draftCriteria(m.description);
      m.criteria = drafted.map((text, i) => ({ id: `c${i + 1}`, text, weight: 1 }));
      this.trace(m, "ai", `Drafted ${m.criteria.length} acceptance criteria from the description`, { criteria: drafted, provider: this.ai.name }, "ai");
    }

    this.trace(m, "milestone", `Milestone created: ${title} (${currency} ${amount.toFixed(2)})`, { source: m.source }, "freelancer");
    return this.store.put(m);
  }

  // ---------- funding (client) ----------

  async createOrder(id) {
    const m = this.get(id);
    this.expect(m, "createOrder");
    const order = await this.paypal.createAuthorizeOrder(
      {
        amount: m.amount,
        currency: m.currency,
        description: `ProofPay milestone: ${m.title}`,
        referenceId: m.id,
        returnUrl: `${this.config.baseUrl}/m/${m.id}?k=${m.clientKey}&paypal=return`,
        cancelUrl: `${this.config.baseUrl}/m/${m.id}?k=${m.clientKey}&paypal=cancel`,
      },
      this.paypalLog(m),
    );
    m.paypal.orderId = order.orderId;
    m.paypal.approveUrl = order.approveUrl;
    this.store.put(m);
    return order;
  }

  async authorize(id, orderId) {
    const m = this.get(id);
    this.expect(m, "authorize");
    if (orderId && m.paypal.orderId && orderId !== m.paypal.orderId) throw new AppError(400, "Order does not belong to this milestone");
    const auth = await this.paypal.authorizeOrder(orderId || m.paypal.orderId, this.paypalLog(m));
    if (Number(auth.amount?.value) + 0.001 < m.amount) {
      throw new AppError(400, "Authorized amount is less than the milestone amount");
    }
    Object.assign(m.paypal, {
      orderId: orderId || m.paypal.orderId,
      authorizationId: auth.authorizationId,
      authStatus: auth.status,
      authorizedAmount: Number(auth.amount.value),
      expiresAt: auth.expiresAt,
      honorUntil: auth.honorUntil,
      payer: auth.payer,
    });
    this.setStatus(m, "funded", "client");
    this.trace(m, "milestone", `Client's money is on hold with PayPal (${m.currency} ${m.amount.toFixed(2)}), not charged`, { expiresAt: auth.expiresAt }, "client");
    return this.store.put(m);
  }

  // ---------- delivery + verification ----------

  async submit(id, { url, notes }) {
    const m = this.get(id);
    this.expect(m, "submit");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError(400, "Submit a valid link to the work");
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new AppError(400, "Link must start with http or https");
    const n = m.submissions.length + 1;
    m.submissions.push({ n, url: parsed.href, notes: String(notes || "").slice(0, 1000), at: this.now().toISOString() });
    m.partialOffer = null;
    this.setStatus(m, "submitted", "freelancer");
    this.trace(m, "milestone", `Work submitted (attempt ${n}): ${parsed.href}`, undefined, "freelancer");
    return this.store.put(m);
  }

  async verify(id) {
    const m = this.get(id);
    if (m.status !== "submitted") throw new AppError(409, `Nothing to verify while ${m.status.replace(/_/g, " ")}`);
    const submission = m.submissions.at(-1);
    this.setStatus(m, "verifying");
    this.store.put(m);

    try {
      const evidence = await this.verifier.collect(submission.url);
      this.trace(m, "evidence", `Collected evidence from ${submission.url} (${evidence.method})`, {
        method: evidence.method,
        title: evidence.title,
        screenshots: evidence.screenshots?.map((s) => s.label),
        textChars: evidence.text?.length,
        checks: evidence.checks,
      });

      const results = await this.ai.verify({ milestone: m, evidence });
      this.trace(m, "ai", `AI judged ${results.length} criteria`, { provider: this.ai.name, results }, "ai");

      const decision = decide({
        criteria: m.criteria,
        results,
        amount: m.amount,
        minConfidence: this.config.policy.minConfidence,
        partialThreshold: this.config.policy.partialThreshold,
      });
      this.trace(m, "policy", decision.reason, decision, "policy");

      m.verifications.push({
        n: submission.n,
        at: this.now().toISOString(),
        url: submission.url,
        results,
        decision,
        screenshots: evidence.screenshots || [],
        method: evidence.method,
      });
      m.decision = decision;

      if (decision.action === "auto_release") {
        m.releaseAt = this.windowEndsAt();
        this.setStatus(m, "release_scheduled");
        this.trace(m, "milestone", `Full release scheduled for ${m.releaseAt} unless the client objects`);
      } else if (decision.action === "human_review") {
        m.releaseAt = null;
        this.setStatus(m, "needs_review");
      } else {
        m.releaseAt = null;
        this.setStatus(m, "changes_requested");
      }
    } catch (err) {
      m.releaseAt = null;
      this.trace(m, "error", `Verification failed: ${err.message}`);
      this.setStatus(m, "submitted");
      this.store.put(m);
      throw err;
    }
    return this.store.put(m);
  }

  // ---------- release decisions ----------

  async offerPartial(id) {
    const m = this.get(id);
    this.expect(m, "offerPartial");
    const amount = m.decision?.partialAmount;
    if (!(amount > 0)) throw new AppError(409, "No partial amount is available for this result");
    m.partialOffer = { amount, at: this.now().toISOString() };
    m.releaseAt = this.windowEndsAt();
    this.setStatus(m, "partial_offered", "freelancer");
    this.trace(m, "milestone", `Freelancer offered a partial release of ${m.currency} ${amount.toFixed(2)}; the rest goes back to the client`, undefined, "freelancer");
    return this.store.put(m);
  }

  async approve(id) {
    const m = this.get(id);
    this.expect(m, "approve");
    this.trace(m, "human", "Client approved the release early", undefined, "client");
    return this.release(m, "client");
  }

  async object(id, reason) {
    const m = this.get(id);
    this.expect(m, "object");
    m.objection = { reason: String(reason || "").slice(0, 1000), at: this.now().toISOString() };
    m.releaseAt = null;
    this.setStatus(m, "disputed", "client");
    this.trace(m, "human", `Client objected: ${m.objection.reason || "(no reason given)"}. Money stays on hold for review.`, undefined, "client");
    return this.store.put(m);
  }

  async resolve(id, { action, amount }) {
    const m = this.get(id);
    this.expect(m, "resolve");
    this.trace(m, "human", `Reviewer resolved: ${action}${amount ? ` ${amount}` : ""}`, { action, amount }, "reviewer");
    if (action === "release") return this.capture(m, m.amount, "reviewer");
    if (action === "partial") {
      const value = round2(Number(amount));
      if (!(value > 0 && value < m.amount)) throw new AppError(400, "Partial amount must be between 0 and the milestone amount");
      return this.capture(m, value, "reviewer");
    }
    if (action === "refund") return this.voidHold(m, "reviewer");
    throw new AppError(400, "Action must be release, partial or refund");
  }

  async cancel(id, actor) {
    const m = this.get(id);
    if (!OPEN_STATUSES.includes(m.status) || m.status === "verifying") {
      throw new AppError(409, `Cannot cancel while ${m.status.replace(/_/g, " ")}`);
    }
    if (actor === "client" && m.status !== "awaiting_funding") {
      const due = m.dueDate ? new Date(m.dueDate) : null;
      const overdueWithoutWork = due && this.now() > due && !m.submissions.length;
      if (!overdueWithoutWork) throw new AppError(409, "Once funded, the client can cancel only if the due date passes with no work submitted");
    }
    if (!m.paypal.authorizationId) {
      this.setStatus(m, "cancelled", actor);
      return this.store.put(m);
    }
    return this.voidHold(m, actor);
  }

  // Called by the scheduler: release anything whose objection window has closed.
  async tick() {
    const now = this.now();
    const due = this.store
      .list()
      .filter((m) => ["release_scheduled", "partial_offered"].includes(m.status) && m.releaseAt && new Date(m.releaseAt) <= now);
    const done = [];
    for (const m of due) {
      try {
        this.trace(m, "policy", "Objection window closed with no objection; releasing", undefined, "policy");
        done.push(await this.release(m, "policy"));
      } catch (err) {
        this.trace(m, "error", `Automatic release failed: ${err.message}`);
        this.store.put(m);
      }
    }
    return done;
  }

  async release(m, actor) {
    if (m.status === "partial_offered") return this.capture(m, m.partialOffer.amount, actor);
    return this.capture(m, m.amount, actor);
  }

  async capture(m, amount, actor) {
    if (!m.paypal.authorizationId) throw new AppError(409, "There is no PayPal hold to capture");
    if (m.paypal.captures.some((c) => c.final)) throw new AppError(409, "This milestone was already captured");
    const max = m.paypal.authorizedAmount ?? m.amount;
    if (amount > max + 0.001) throw new AppError(409, "Capture would exceed the authorized amount");
    if (m.paypal.expiresAt && this.now() > new Date(m.paypal.expiresAt)) throw new AppError(409, "The PayPal authorization has expired");

    const partial = amount < m.amount;
    const result = await this.paypal.captureAuthorization(
      m.paypal.authorizationId,
      {
        amount,
        currency: m.currency,
        finalCapture: true,
        invoiceId: `proofpay-${m.id}`,
        note: partial ? `Partial release for ${m.title}; the rest of the hold is released to you.` : `Payment for ${m.title}`,
        requestId: `${m.id}-capture-final`,
      },
      this.paypalLog(m),
    );
    m.paypal.captures.push({ id: result.captureId, amount, status: result.status, final: true, breakdown: result.breakdown, at: this.now().toISOString() });
    m.releaseAt = null;
    this.setStatus(m, partial ? "partially_released" : "released", actor);
    this.trace(
      m,
      "milestone",
      partial
        ? `Released ${m.currency} ${amount.toFixed(2)} to the freelancer; ${m.currency} ${(m.amount - amount).toFixed(2)} of the hold released back to the client`
        : `Released ${m.currency} ${amount.toFixed(2)} to the freelancer`,
      undefined,
      actor,
    );
    return this.store.put(m);
  }

  async voidHold(m, actor) {
    await this.paypal.voidAuthorization(m.paypal.authorizationId, this.paypalLog(m));
    m.releaseAt = null;
    this.setStatus(m, "cancelled", actor);
    this.trace(m, "milestone", "PayPal hold voided; the client's money is released", undefined, actor);
    return this.store.put(m);
  }
}

// Strip secrets before sending a milestone to a browser.
export function toPublic(m, role) {
  const { clientKey, freelancerKey, ...rest } = m;
  const out = { ...rest, role };
  if (role === "freelancer") out.clientLink = `/m/${m.id}?k=${clientKey}`;
  if (role === "freelancer") out.freelancerLink = `/f/${m.id}?k=${freelancerKey}`;
  return out;
}

export function roleFor(m, key) {
  if (!key) return null;
  if (key === m.freelancerKey) return "freelancer";
  if (key === m.clientKey) return "client";
  return null;
}
