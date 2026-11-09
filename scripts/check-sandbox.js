// Verifies PayPal sandbox credentials and that the account can create an AUTHORIZE order.
// Usage: npm run check:sandbox
import { config } from "../src/config.js";
import { PayPalClient } from "../src/paypal/client.js";

const { clientId, clientSecret, mode } = config.paypal;
if (!clientId || !clientSecret) {
  console.error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}

const paypal = new PayPalClient({ clientId, clientSecret, mode: mode === "mock" ? "sandbox" : mode });

try {
  await paypal.accessToken();
  console.log(`PayPal ${paypal.mode} OK - access token received`);
  const order = await paypal.createAuthorizeOrder(
    { amount: 1, currency: config.defaultCurrency, description: "ProofPay sandbox check", referenceId: `check-${Date.now()}` },
    (call) => console.log(`  ${call.method} ${call.path} -> ${call.status}`),
  );
  console.log(`AUTHORIZE order created: ${order.orderId} (${order.status})`);
  console.log(`Buyer approval link: ${order.approveUrl}`);
} catch (err) {
  console.error(`PayPal check failed: ${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exit(1);
}
