// Loads .env (if present) and exposes typed configuration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

const env = (key, fallback = "") => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

const hasPayPalKeys = Boolean(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET"));

function pickAiProvider() {
  const forced = env("AI_PROVIDER").toLowerCase();
  if (forced) return forced;
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  if (env("OPENAI_API_KEY")) return "openai";
  return "mock";
}

export const config = {
  port: Number(env("PORT", "3000")),
  baseUrl: env("BASE_URL", env("RENDER_EXTERNAL_URL", `http://localhost:${env("PORT", "3000")}`)),
  defaultCurrency: env("DEFAULT_CURRENCY", "SGD"),
  objectionWindowSeconds: Number(env("OBJECTION_WINDOW_SECONDS", "172800")),
  dataFile: env("DATA_FILE", path.join(ROOT, "data", "db.json")),
  paypal: {
    // Without keys we always fall back to the offline mock, whatever PAYPAL_MODE says.
    mode: hasPayPalKeys ? env("PAYPAL_MODE", "sandbox").toLowerCase() : "mock",
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
  },
  ai: {
    provider: pickAiProvider(),
    anthropicModel: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
    openaiModel: env("OPENAI_MODEL", "gpt-4.1-mini"),
  },
  policy: {
    // A criterion only counts as passed when the AI is at least this confident.
    minConfidence: 0.7,
    // Below this share of passed criteria, nothing is offered automatically.
    partialThreshold: 0.5,
  },
};

export function paypalBaseUrl(mode = config.paypal.mode) {
  return mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
