// Rule-based stand-in for the AI, so ProofPay runs with no API key.
// It is deliberately simple and labelled "mock" everywhere it appears.

const TEMPLATES = [
  [/pric|cost|rate|package|plan/i, "Has a pricing section with at least three priced items"],
  [/contact|enquir|inquir|form|lead|book/i, "Has a contact form with name, email and message fields"],
  [/mobile|phone|responsive/i, "Works on a phone-sized screen without horizontal scrolling"],
  [/testimonial|review|customer/i, "Shows at least two customer testimonials"],
  [/menu|product|catalog|shop/i, "Lists at least three products or menu items"],
  [/about|story|team/i, "Has an About section describing the business"],
  [/gallery|photo|image|portfolio/i, "Shows at least four images in a gallery or portfolio"],
];

export class MockAI {
  constructor() {
    this.name = "mock (rule-based)";
  }

  async draftCriteria(description) {
    const out = ["Has a main heading that names the business or product"];
    for (const [re, text] of TEMPLATES) if (re.test(description) && !out.includes(text)) out.push(text);
    for (const [, text] of TEMPLATES) {
      if (out.length >= 4) break;
      if (!out.includes(text) && /pricing|contact|phone/.test(text)) out.push(text);
    }
    return out.slice(0, 6);
  }

  async verify({ milestone, evidence }) {
    const text = (evidence.text || "").toLowerCase();
    const checks = evidence.checks || {};
    const injected = checks.injectionSuspected;
    return milestone.criteria.map((c) => {
      const result = judge(c.text, text, checks);
      if (injected) result.confidence = Math.min(result.confidence, 0.5);
      return { criterionId: c.id, ...result };
    });
  }
}

function judge(criterion, text, checks) {
  const t = criterion.toLowerCase();
  const prices = (text.match(/(s\$|\$|₹|€|£|rs\.?)\s?\d/g) || []).length;

  if (/pric/.test(t)) {
    const pass = /pric/.test(text) && prices >= 3;
    return out(pass, 0.85, pass ? `Found a pricing section with ${prices} prices` : `Found ${prices} prices`, "page text");
  }
  if (/form/.test(t)) {
    const form = (checks.forms || []).find((f) => f.fields.some((x) => x.type === "email" || /mail/i.test(x.name || "")));
    const hasMessage = form?.fields.some((x) => x.tag === "textarea");
    const pass = Boolean(form && hasMessage && form.hasSubmit);
    return out(pass, 0.9, pass ? `Form with ${form.fields.length} fields including email and a message box` : "No form with email and message fields found", "page checks");
  }
  if (/phone|mobile|horizontal/.test(t)) {
    const overflow = checks.mobile?.horizontalOverflow;
    if (overflow === null || overflow === undefined) return out(false, 0.5, "Mobile layout could not be measured without a browser", "none");
    const pass = !overflow && checks.viewportMeta;
    return out(pass, 0.85, pass ? "No horizontal scrolling at 390px wide; viewport meta tag present" : "Page scrolls sideways at 390px wide", "page checks");
  }
  if (/heading/.test(t)) {
    const h1 = (checks.headings || []).find((h) => h.startsWith("h1"));
    return out(Boolean(h1), 0.85, h1 ? `Main heading: "${h1.slice(4)}"` : "No main heading found", "page checks");
  }
  if (/products|menu items|items/.test(t)) {
    const items = (checks.headings || []).filter((h) => h.startsWith("h3")).length;
    const pass = items >= 3;
    return out(pass, 0.8, `Found ${items} item headings`, "page checks");
  }
  if (/testimonial/.test(t)) {
    const n = (text.match(/[“"][^”"]{15,}[”"]/g) || []).length;
    const pass = /testimonial|what (our )?(customers|clients) say|review/.test(text) && n >= 2;
    return out(pass, 0.75, `Found ${n} quoted testimonials`, "page text");
  }
  // Fallback: keyword overlap, reported with low confidence so a person checks it.
  const words = t.match(/[a-z]{5,}/g) || [];
  const hits = words.filter((w) => text.includes(w));
  const ratio = words.length ? hits.length / words.length : 0;
  return out(ratio >= 0.6, 0.6, `Mock check matched ${hits.length} of ${words.length} keywords`, "page text");
}

const out = (pass, confidence, evidence, source) => ({ pass, confidence, evidence, source });
