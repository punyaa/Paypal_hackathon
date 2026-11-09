// Collects evidence from a submitted link: page text, structure checks and
// desktop + mobile screenshots. Uses Playwright when available, otherwise plain fetch.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ROOT } from "./config.js";

const require = createRequire(import.meta.url);
export const EVIDENCE_DIR = path.join(ROOT, "data", "evidence");

// Text that tries to talk to the AI verifier instead of the human reader.
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /(mark|treat|consider) (all|every|each) (the )?criteri(a|on)/i,
  /\b(ai|llm|model|verifier|assistant)\b[^.]{0,40}\b(must|should) (pass|approve|mark)/i,
  /system prompt/i,
  /you are (an|the) (ai|verifier|assistant)/i,
];

export function detectInjection(text) {
  const hits = [];
  for (const re of INJECTION) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function loadPlaywright() {
  if (process.env.PROOFPAY_VERIFIER === "fetch") return null;
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

export function createVerifier() {
  const pw = loadPlaywright();
  return pw ? new BrowserEvidence(pw) : new FetchEvidence();
}

const PAGE_CHECKS = () => {
  const forms = [...document.querySelectorAll("form")].map((f) => ({
    fields: [...f.querySelectorAll("input, textarea, select")]
      .filter((i) => i.type !== "hidden")
      .map((i) => ({ tag: i.tagName.toLowerCase(), type: i.type || null, name: i.name || i.id || i.placeholder || null })),
    hasSubmit: !!f.querySelector('button, input[type="submit"]'),
  }));
  const hiddenText = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const s = getComputedStyle(el);
      return el.childElementCount === 0 && el.textContent.trim().length > 20 && (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0 || s.fontSize === "0px");
    })
    .map((el) => el.textContent.trim().slice(0, 200));
  return {
    title: document.title,
    headings: [...document.querySelectorAll("h1, h2, h3")].map((h) => `${h.tagName.toLowerCase()}: ${h.textContent.trim().slice(0, 120)}`).slice(0, 30),
    forms,
    links: document.querySelectorAll("a[href]").length,
    images: document.images.length,
    imagesWithoutAlt: [...document.images].filter((i) => !i.alt).length,
    viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    hiddenText,
  };
};

class BrowserEvidence {
  constructor(pw) {
    this.pw = pw;
    this.name = "playwright";
  }

  async collect(url) {
    const browser = await this.pw.chromium.launch();
    const consoleErrors = [];
    try {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await desktop.newPage();
      page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text().slice(0, 200)));
      page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 200)));
      const started = Date.now();
      const response = await page.goto(url, { waitUntil: "load", timeout: 25_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const loadMs = Date.now() - started;
      const checks = await page.evaluate(PAGE_CHECKS);
      const text = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 20_000);
      const shotDesktop = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: undefined });

      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
      const mpage = await mobile.newPage();
      await mpage.goto(url, { waitUntil: "load", timeout: 25_000 });
      await mpage.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const mobileChecks = await mpage.evaluate(PAGE_CHECKS);
      const shotMobile = await mpage.screenshot({ type: "jpeg", quality: 60, fullPage: true });

      const injection = detectInjection([text, ...checks.hiddenText].join("\n"));
      return {
        method: "playwright",
        url,
        title: checks.title,
        text,
        checks: {
          httpStatus: response?.status() ?? null,
          loadMs,
          consoleErrors,
          headings: checks.headings,
          forms: checks.forms,
          links: checks.links,
          images: checks.images,
          imagesWithoutAlt: checks.imagesWithoutAlt,
          viewportMeta: checks.viewportMeta,
          mobile: { horizontalOverflow: mobileChecks.horizontalOverflow, width: 390 },
          hiddenText: checks.hiddenText,
          injectionSuspected: injection.length > 0,
          injectionMatches: injection,
        },
        screenshots: [save(shotDesktop, "desktop"), save(shotMobile, "mobile")],
      };
    } finally {
      await browser.close();
    }
  }
}

class FetchEvidence {
  constructor() {
    this.name = "fetch";
  }

  async collect(url) {
    const started = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": "ProofPayVerifier/0.1" }, redirect: "follow" });
    const html = (await res.text()).slice(0, 500_000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20_000);
    const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map((f) => ({
      fields: [...f[0].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
        .map((i) => ({ tag: i[1].toLowerCase(), type: (i[2].match(/type=["']?(\w+)/i) || [])[1] || null, name: (i[2].match(/name=["']?([\w-]+)/i) || [])[1] || null }))
        .filter((i) => i.type !== "hidden"),
      hasSubmit: /<button|type=["']?submit/i.test(f[0]),
    }));
    const injection = detectInjection(text);
    return {
      method: "fetch",
      url,
      title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "",
      text,
      checks: {
        httpStatus: res.status,
        loadMs: Date.now() - started,
        headings: [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)].map((h) => `${h[1].toLowerCase()}: ${h[2].replace(/<[^>]+>/g, "").trim()}`).slice(0, 30),
        forms,
        viewportMeta: /<meta[^>]+name=["']viewport["']/i.test(html),
        mobile: { horizontalOverflow: null, note: "Not measured without a browser" },
        injectionSuspected: injection.length > 0,
        injectionMatches: injection,
      },
      screenshots: [],
    };
  }
}

function save(buffer, label) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${label}.jpg`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, file), buffer);
  return { label, path: `/evidence/${file}`, base64: buffer.toString("base64"), mimeType: "image/jpeg" };
}
