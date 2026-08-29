import type { GuardDecision, GuardResult } from "../contracts.js";

const DECISION_RANK: Record<GuardDecision, number> = {
  allow: 0,
  allow_with_warning: 1,
  require_approval: 2,
  deny: 3,
};

export function mergeGuardResults(results: readonly GuardResult[]): GuardResult {
  if (results.length === 0) {
    throw new RangeError("At least one guard result is required.");
  }
  const strictest = results.reduce((current, result) =>
    DECISION_RANK[result.decision] > DECISION_RANK[current.decision] ? result : current,
  );
  const assurance = results.some((result) => result.assurance === "unassessed")
    ? "unassessed"
    : results.some((result) => result.assurance === "low")
      ? "low"
      : results.some((result) => result.assurance === "medium")
        ? "medium"
        : "high";

  return {
    findings: results.flatMap((result) => result.findings),
    assurance,
    decision: strictest.decision,
    reasons: [...new Set(results.flatMap((result) => result.reasons))],
    limitations: [...new Set(results.flatMap((result) => result.limitations))],
  };
}
