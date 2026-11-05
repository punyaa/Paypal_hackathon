// Verifies PayPal sandbox credentials by requesting an OAuth access token.
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT = "SANDBOX" } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}

const base =
  PAYPAL_ENVIRONMENT.toUpperCase() === "PRODUCTION"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

const res = await fetch(`${base}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});

const data = await res.json();

if (!res.ok) {
  console.error(`PayPal auth failed (${res.status}):`, data.error_description || data);
  process.exit(1);
}

console.log(`PayPal ${PAYPAL_ENVIRONMENT.toLowerCase()} OK - token expires in ${data.expires_in}s`);
