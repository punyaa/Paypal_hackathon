import { test } from "node:test";
import assert from "node:assert/strict";
import { PayPalClient } from "../src/paypal/client.js";
import { MockPayPalClient } from "../src/paypal/mock.js";

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, headers: init.headers, body: init.body ? safeJson(init.body) : undefined });
    const handler = routes[`${init.method} ${path}`];
    if (!handler) throw new Error(`Unexpected ${init.method} ${path}`);
    const { status = 200, body = {} } = handler(calls.at(-1));
    return {
      ok: status < 400,
      status,
      headers: { get: (h) => (h === "paypal-debug-id" ? "dbg123" : null) },
      json: async () => body,
      text: async () => (body === null ? "" : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const token = { "POST /v1/oauth2/token": () => ({ body: { access_token: "T", expires_in: 3600 } }) };

test("createAuthorizeOrder sends intent AUTHORIZE and returns approve link", async () => {
  const fetch = fakeFetch({
    ...token,
    "POST /v2/checkout/orders": () => ({
      status: 201,
      body: { id: "O1", status: "CREATED", links: [{ rel: "approve", href: "https://pp/approve" }] },
    }),
  });
  const pp = new PayPalClient({ clientId: "a", clientSecret: "b", fetchImpl: fetch });
  const logs = [];
  const res = await pp.createAuthorizeOrder({ amount: 1200, currency: "SGD", referenceId: "m1" }, (e) => logs.push(e));
  assert.equal(res.orderId, "O1");
  assert.equal(res.approveUrl, "https://pp/approve");
  const body = fetch.calls[1].body;
  assert.equal(body.intent, "AUTHORIZE");
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: "SGD", value: "1200.00" });
  assert.equal(logs[0].status, 201);
  assert.equal(logs[0].debugId, "dbg123");
});

test("authorizeOrder extracts the authorization", async () => {
  const fetch = fakeFetch({
    ...token,
    "POST /v2/checkout/orders/O1/authorize": () => ({
      status: 201,
      body: {
        id: "O1",
        status: "COMPLETED",
        payer: { email_address: "c@x.com", payer_id: "P1" },
        purchase_units: [
          {
            payments: {
              authorizations: [
                { id: "A1", status: "CREATED", amount: { currency_code: "SGD", value: "1200.00" }, expiration_time: "2026-12-08T00:00:00Z", create_time: "2026-11-09T00:00:00Z" },
              ],
            },
          },
        ],
      },
    }),
  });
  const pp = new PayPalClient({ clientId: "a", clientSecret: "b", fetchImpl: fetch });
  const res = await pp.authorizeOrder("O1");
  assert.equal(res.authorizationId, "A1");
  assert.equal(res.payer.email, "c@x.com");
  assert.equal(res.honorUntil, "2026-11-12T00:00:00.000Z");
});

test("captureAuthorization sends partial amount with final_capture and request id", async () => {
  const fetch = fakeFetch({
    ...token,
    "POST /v2/payments/authorizations/A1/capture": () => ({ status: 201, body: { id: "C1", status: "COMPLETED", amount: { currency_code: "SGD", value: "900.00" } } }),
  });
  const pp = new PayPalClient({ clientId: "a", clientSecret: "b", fetchImpl: fetch });
  const res = await pp.captureAuthorization("A1", { amount: 900, currency: "SGD", finalCapture: true, requestId: "m1-cap" });
  assert.equal(res.captureId, "C1");
  const call = fetch.calls[1];
  assert.equal(call.body.final_capture, true);
  assert.equal(call.body.amount.value, "900.00");
  assert.equal(call.headers["PayPal-Request-Id"], "m1-cap");
});

test("errors surface PayPal issue codes", async () => {
  const fetch = fakeFetch({
    ...token,
    "POST /v2/payments/authorizations/A1/void": () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_VOIDED" }] } }),
  });
  const pp = new PayPalClient({ clientId: "a", clientSecret: "b", fetchImpl: fetch });
  await assert.rejects(pp.voidAuthorization("A1"), /PREVIOUSLY_VOIDED/);
});

test("mock client runs the full authorize, capture, void cycle", async () => {
  const pp = new MockPayPalClient();
  const logs = [];
  const log = (e) => logs.push(e);
  const order = await pp.createAuthorizeOrder({ amount: 500, currency: "SGD", referenceId: "m2" }, log);
  const auth = await pp.authorizeOrder(order.orderId, log);
  assert.equal(auth.amount.value, "500.00");
  const cap = await pp.captureAuthorization(auth.authorizationId, { amount: 375, currency: "SGD", finalCapture: true }, log);
  assert.equal(cap.amount.value, "375.00");
  assert.ok(cap.breakdown.paypal_fee);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => l.mock));
});
