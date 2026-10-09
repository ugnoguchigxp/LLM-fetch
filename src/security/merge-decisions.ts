import type { GuardDecision, GuardResult } from "../contracts.js";
import {
  copyGuardDiagnostics,
  freezeGuardReasonCodes,
  orderGuardReasonCodes,
} from "./guard-codes.js";

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

  const hasReasonCodes = results.some((result) => result.reasonCodes !== undefined);
  const diagnostics = results.flatMap((result) => result.diagnostics ?? []);
  const hasDiagnostics = results.some((result) => result.diagnostics !== undefined);
  return {
    findings: results.flatMap((result) => result.findings),
    assurance,
    decision: strictest.decision,
    reasons: [...new Set(results.flatMap((result) => result.reasons))],
    limitations: [...new Set(results.flatMap((result) => result.limitations))],
    ...(hasReasonCodes
      ? {
          reasonCodes: freezeGuardReasonCodes(
            orderGuardReasonCodes(results.flatMap((result) => [...(result.reasonCodes ?? [])])),
          ),
        }
      : {}),
    ...(hasDiagnostics ? { diagnostics: copyGuardDiagnostics(diagnostics.slice(0, 8)) } : {}),
  };
}

export function markAdditionalGuardRestriction(result: GuardResult): GuardResult {
  if (result.decision !== "require_approval" && result.decision !== "deny") return result;
  return {
    ...result,
    reasonCodes: freezeGuardReasonCodes([
      ...(result.reasonCodes ?? []),
      "ADDITIONAL_GUARD_RESTRICTION",
    ]),
  };
}
