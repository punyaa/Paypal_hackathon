// PayPal REST client for the escrow flow: authorize now, capture or void later.
// Every call is reported through `log` so it can be shown in the milestone trace.
//
// Orders v2:   POST /v2/checkout/orders (intent AUTHORIZE), GET /v2/checkout/orders/:id,
//              POST /v2/checkout/orders/:id/authorize
// Payments v2: POST /v2/payments/authorizations/:id/capture | /void | /reauthorize,
//              GET  /v2/payments/authorizations/:id

import { paypalBaseUrl } from "../config.js";

const REDACT = /(authorization|secret|password|token)/i;

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, REDACT.test(k) && typeof v === "string" ? "[redacted]" : redact(v)]),
  );
}

export const money = (value, currency) => ({ currency_code: currency, value: Number(value).toFixed(2) });

export class PayPalClient {
  constructor({ clientId, clientSecret, mode = "sandbox", fetchImpl = globalThis.fetch }) {
    if (!clientId || !clientSecret) throw new Error("PayPal client ID and secret are required");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.mode = mode;
    this.base = paypalBaseUrl(mode);
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = await res.json();
    if (!res.ok) throw new PayPalError("OAuth token request failed", res.status, data);
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  async request(method, path, { body, requestId, log } = {}) {
    const started = Date.now();
    const headers = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    log?.({
      kind: "paypal",
      method,
      path,
      requestId,
      request: redact(body),
      status: res.status,
      debugId: res.headers.get("paypal-debug-id"),
      response: summarize(data),
      ms: Date.now() - started,
    });
    if (!res.ok) throw new PayPalError(`${method} ${path} failed`, res.status, data);
    return data;
  }

  async createAuthorizeOrder({ amount, currency, description, referenceId, invoiceId, returnUrl, cancelUrl }, log) {
    const body = {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: referenceId,
          description: description?.slice(0, 127),
          custom_id: referenceId,
          invoice_id: invoiceId,
          amount: money(amount, currency),
        },
      ],
    };
    if (returnUrl) {
      body.payment_source = {
        paypal: {
          experience_context: {
            brand_name: "ProofPay",
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
            return_url: returnUrl,
            cancel_url: cancelUrl || returnUrl,
          },
        },
      };
    }
    const data = await this.request("POST", "/v2/checkout/orders", { body, requestId: `${referenceId}-order-${Date.now()}`, log });
    return { orderId: data.id, status: data.status, approveUrl: linkOf(data, "payer-action") || linkOf(data, "approve") };
  }

  async getOrder(orderId, log) {
    return this.request("GET", `/v2/checkout/orders/${orderId}`, { log });
  }

  async authorizeOrder(orderId, log) {
    const data = await this.request("POST", `/v2/checkout/orders/${orderId}/authorize`, {
      body: {},
      requestId: `${orderId}-authorize`,
      log,
    });
    const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError("Order authorized but no authorization returned", 500, data);
    return {
      authorizationId: auth.id,
      status: auth.status,
      amount: auth.amount,
      expiresAt: auth.expiration_time,
      honorUntil: honorPeriodEnd(auth.create_time),
      payer: data.payer ? { email: data.payer.email_address, payerId: data.payer.payer_id } : null,
    };
  }

  async getAuthorization(authorizationId, log) {
    return this.request("GET", `/v2/payments/authorizations/${authorizationId}`, { log });
  }

  async captureAuthorization(authorizationId, { amount, currency, finalCapture = true, invoiceId, note, requestId }, log) {
    const data = await this.request("POST", `/v2/payments/authorizations/${authorizationId}/capture`, {
      body: {
        amount: money(amount, currency),
        final_capture: finalCapture,
        invoice_id: invoiceId,
        note_to_payer: note?.slice(0, 255),
      },
      requestId,
      log,
    });
    return {
      captureId: data.id,
      status: data.status,
      amount: data.amount,
      breakdown: data.seller_receivable_breakdown || null,
    };
  }

  async voidAuthorization(authorizationId, log) {
    await this.request("POST", `/v2/payments/authorizations/${authorizationId}/void`, {
      requestId: `${authorizationId}-void`,
      log,
    });
    return { status: "VOIDED" };
  }

  async reauthorize(authorizationId, { amount, currency }, log) {
    const data = await this.request("POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`, {
      body: { amount: money(amount, currency) },
      log,
    });
    return { authorizationId: data.id, status: data.status, expiresAt: data.expiration_time };
  }
}

export class PayPalError extends Error {
  constructor(message, status, details) {
    const issue = details?.details?.[0]?.issue || details?.name || details?.error;
    super(issue ? `${message}: ${issue}` : message);
    this.status = status;
    this.details = details;
  }
}

function linkOf(data, rel) {
  return data.links?.find((l) => l.rel === rel)?.href || null;
}

function honorPeriodEnd(createTime) {
  const t = createTime ? new Date(createTime).getTime() : Date.now();
  return new Date(t + 3 * 24 * 3600 * 1000).toISOString();
}

// Keep trace entries small: ids, statuses and amounts, not whole payloads.
function summarize(data) {
  if (!data || typeof data !== "object") return data;
  const pick = {};
  for (const key of ["id", "status", "intent", "expiration_time", "final_capture", "name", "message", "debug_id"]) {
    if (data[key] !== undefined) pick[key] = data[key];
  }
  if (data.amount) pick.amount = data.amount;
  const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (auth) pick.authorization = { id: auth.id, status: auth.status, amount: auth.amount, expiration_time: auth.expiration_time };
  if (data.seller_receivable_breakdown) pick.seller_receivable_breakdown = data.seller_receivable_breakdown;
  if (data.details) pick.details = data.details;
  return pick;
}
