// Offline stand-in for PayPal with the same interface as PayPalClient.
// Lets the full flow run without sandbox keys. Responses mirror PayPal's shapes.
import crypto from "node:crypto";
import { money } from "./client.js";

const id = (prefix) => `${prefix}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const days = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

export class MockPayPalClient {
  constructor() {
    this.mode = "mock";
    this.orders = new Map();
    this.authorizations = new Map();
  }

  record(log, method, path, request, status, response) {
    log?.({ kind: "paypal", mock: true, method, path, request, status, debugId: id("mock-"), response, ms: 1 });
  }

  async createAuthorizeOrder({ amount, currency, referenceId, description }, log) {
    const orderId = id("MOCK-ORDER-");
    const order = { id: orderId, status: "CREATED", intent: "AUTHORIZE", amount: money(amount, currency), referenceId, description };
    this.orders.set(orderId, order);
    this.record(log, "POST", "/v2/checkout/orders", { intent: "AUTHORIZE", amount: order.amount, reference_id: referenceId }, 201, {
      id: orderId,
      status: "CREATED",
    });
    return { orderId, status: "CREATED", approveUrl: null };
  }

  async getOrder(orderId, log) {
    const order = this.orders.get(orderId) || { id: orderId, status: "APPROVED" };
    this.record(log, "GET", `/v2/checkout/orders/${orderId}`, undefined, 200, { id: order.id, status: order.status });
    return order;
  }

  async authorizeOrder(orderId, log) {
    const order = this.orders.get(orderId);
    const authorizationId = id("MOCK-AUTH-");
    const amount = order?.amount || money(0, "SGD");
    const auth = { id: authorizationId, status: "CREATED", amount, expiration_time: days(29), captured: 0 };
    this.authorizations.set(authorizationId, auth);
    if (order) order.status = "COMPLETED";
    this.record(log, "POST", `/v2/checkout/orders/${orderId}/authorize`, {}, 201, {
      id: orderId,
      status: "COMPLETED",
      authorization: { id: authorizationId, status: "CREATED", amount, expiration_time: auth.expiration_time },
    });
    return {
      authorizationId,
      status: "CREATED",
      amount,
      expiresAt: auth.expiration_time,
      honorUntil: days(3),
      payer: { email: "client-buyer@example.com", payerId: id("PAYER") },
    };
  }

  async getAuthorization(authorizationId, log) {
    const auth = this.authorizations.get(authorizationId) || { id: authorizationId, status: "CREATED" };
    this.record(log, "GET", `/v2/payments/authorizations/${authorizationId}`, undefined, 200, { id: auth.id, status: auth.status });
    return auth;
  }

  async captureAuthorization(authorizationId, { amount, currency, finalCapture = true }, log) {
    const captureId = id("MOCK-CAPTURE-");
    const gross = Number(amount);
    const fee = Math.round((gross * 0.044 + 0.5) * 100) / 100; // illustrative cross-border fee
    const breakdown = {
      gross_amount: money(gross, currency),
      paypal_fee: money(fee, currency),
      net_amount: money(gross - fee, currency),
    };
    const auth = this.authorizations.get(authorizationId);
    if (auth) auth.status = finalCapture ? "CAPTURED" : "PARTIALLY_CAPTURED";
    this.record(log, "POST", `/v2/payments/authorizations/${authorizationId}/capture`, { amount: money(amount, currency), final_capture: finalCapture }, 201, {
      id: captureId,
      status: "COMPLETED",
      final_capture: finalCapture,
      amount: money(amount, currency),
      seller_receivable_breakdown: breakdown,
    });
    return { captureId, status: "COMPLETED", amount: money(amount, currency), breakdown };
  }

  async voidAuthorization(authorizationId, log) {
    const auth = this.authorizations.get(authorizationId);
    if (auth) auth.status = "VOIDED";
    this.record(log, "POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, 204, {});
    return { status: "VOIDED" };
  }

  async reauthorize(authorizationId, { amount, currency }, log) {
    const newId = id("MOCK-AUTH-");
    this.record(log, "POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`, { amount: money(amount, currency) }, 201, {
      id: newId,
      status: "CREATED",
    });
    return { authorizationId: newId, status: "CREATED", expiresAt: days(29) };
  }
}
