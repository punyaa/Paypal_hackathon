// Deterministic release policy. The AI only reports what it sees; this code decides
// whether money may move. Kept pure so it is easy to test and to explain.

export function decide({ criteria, results, amount, minConfidence = 0.7, partialThreshold = 0.5, injectionSuspected = false }) {
  const byId = new Map(results.map((r) => [r.criterionId, r]));
  let total = 0;
  let passedWeight = 0;
  const passed = [];
  const failed = [];
  const lowConfidence = [];

  for (const c of criteria) {
    const weight = c.weight ?? 1;
    total += weight;
    const r = byId.get(c.id);
    if (!r) {
      lowConfidence.push(c.id);
      continue;
    }
    if (r.confidence < minConfidence) lowConfidence.push(c.id);
    if (r.pass && r.confidence >= minConfidence) {
      passedWeight += weight;
      passed.push(c.id);
    } else if (!r.pass && r.confidence >= minConfidence) {
      failed.push(c.id);
    }
  }

  const score = total ? passedWeight / total : 0;
  const partialAmount = Math.floor(amount * score * 100) / 100;
  let action;
  let reason;

  if (injectionSuspected) {
    action = "human_review";
    reason = "The submitted page contains text addressed to the AI verifier. A person decides, whatever the AI said.";
  } else if (lowConfidence.length) {
    action = "human_review";
    reason = `${lowConfidence.length} criterion(s) could not be judged confidently, so a person decides.`;
  } else if (score === 1) {
    action = "auto_release";
    reason = "Every criterion passed with high confidence. Full release after the objection window.";
  } else if (score >= partialThreshold) {
    action = "offer_partial";
    reason = `${passed.length} of ${criteria.length} criteria passed. The freelancer can fix and resubmit, or offer a ${Math.round(score * 100)}% partial release.`;
  } else {
    action = "request_changes";
    reason = `Only ${passed.length} of ${criteria.length} criteria passed. No money moves until the work is resubmitted.`;
  }

  return { action, reason, score, passed, failed, lowConfidence, partialAmount };
}
