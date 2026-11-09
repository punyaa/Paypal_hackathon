import { config } from "../config.js";
import { PayPalClient } from "./client.js";
import { MockPayPalClient } from "./mock.js";

export function createPayPal(cfg = config.paypal) {
  if (cfg.mode === "mock") return new MockPayPalClient();
  return new PayPalClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, mode: cfg.mode });
}

export { PayPalClient, PayPalError } from "./client.js";
export { MockPayPalClient } from "./mock.js";
