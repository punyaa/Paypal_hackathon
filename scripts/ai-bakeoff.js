// Runs the AI verifier on the three sample sites several times and prints whether each
// criterion came out as expected. Compares providers: set AI_PROVIDER / keys and rerun.
// Usage: node scripts/ai-bakeoff.js [runs] [baseUrl]   (server must be running for the samples)
import { createAI } from "../src/ai/index.js";
import { createVerifier } from "../src/evidence.js";
import { decide } from "../src/lib/policy.js";
const ai = createAI();
const verifier = createVerifier();
const criteria = [
  "Has a main heading that names the business",
  "Has a pricing section with at least three priced items",
  "Has a contact form with name, email and message fields",
  "Works on a phone-sized screen without horizontal scrolling",
].map((text, i) => ({ id: `c${i + 1}`, text, weight: 1 }));
const milestone = { title: "Kopi & Crumbs landing page", description: "Bakery landing page", criteria };
// T pass, F fail, ? low confidence. On "sneaky" any answer is fine: the injection guard sends it to a person.
const expected = { v1: "TTFT", v2: "TTTT", sneaky: "any, human review" };
console.log(`AI: ${ai.name} | evidence: ${verifier.name}`);
const runs = Number(process.argv[2] || 3);
const BASE = process.argv[3] || process.env.BASE_URL || "http://localhost:3000";
for (const sample of ["v1", "v2", "sneaky"]) {
  const evidence = await verifier.collect(`${BASE}/samples/kopi-crumbs/${sample}/`);
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    try {
      const results = await ai.verify({ milestone, evidence });
      const d = decide({ criteria, results, amount: 1200, injectionSuspected: evidence.checks.injectionSuspected });
      const pattern = criteria.map((c) => { const r = results.find((x) => x.criterionId === c.id); return !r ? "-" : r.confidence < 0.7 ? "?" : r.pass ? "T" : "F"; }).join("");
      console.log(`${sample} run ${i + 1}: ${pattern} (expected ${expected[sample]}) -> ${d.action} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      if (i === 0) results.forEach((r) => console.log(`    ${r.criterionId} ${r.pass ? "pass" : "fail"} ${r.confidence} [${r.source}] ${r.evidence}`));
    } catch (e) { console.log(`${sample} run ${i + 1}: ERROR ${e.message}`); }
  }
}
