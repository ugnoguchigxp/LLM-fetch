import type {
  GuardDecision,
  GuardResult,
  RequestedContextUse,
  SecurityFinding,
  SecurityFindingSeverity,
} from "../contracts.js";

const SEVERITY_RANK: Record<SecurityFindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function strongestSeverity(findings: readonly SecurityFinding[]): number {
  return findings.reduce(
    (highest, finding) => Math.max(highest, SEVERITY_RANK[finding.severity]),
    0,
  );
}

export function decideContextPolicy(input: {
  findings: SecurityFinding[];
  requestedUse: RequestedContextUse;
  truncated: boolean;
  truncationReasons?: readonly string[];
}): GuardResult {
  const relevant = input.findings.filter((finding) => finding.category !== "benign_mention");
  const strongest = strongestSeverity(relevant);
  const hasHidden = relevant.some((finding) =>
    ["hidden", "comment", "attribute", "meta", "template"].includes(finding.location),
  );
  const chainsTools =
    input.requestedUse === "search_more" || input.requestedUse === "call_readonly_tool";

  let decision: GuardDecision = "allow";
  const reasons: string[] = [];
  if (input.truncated && chainsTools) {
    decision = "deny";
    reasons.push("Truncated inspection cannot authorize another tool action.");
  } else if (input.truncated) {
    decision = "require_approval";
    reasons.push("Inspection limits were reached before all untrusted content was examined.");
  } else if (strongest >= 3 && chainsTools) {
    decision = "deny";
    reasons.push("High-severity untrusted content cannot initiate another tool action.");
  } else if (strongest >= 3 || (hasHidden && strongest >= 2)) {
    decision = "require_approval";
    reasons.push("High-severity or hidden instructions require explicit approval.");
  } else if (strongest >= 1) {
    decision = "allow_with_warning";
    reasons.push("Potential instructions were found in untrusted content.");
  } else {
    reasons.push("No known injection pattern was detected; content remains untrusted.");
  }

  const limitations = [
    "No finding is not proof of safety.",
    "External stylesheets and computed CSS visibility are not evaluated.",
    "Heuristic rules cannot detect every semantic prompt injection.",
  ];
  if (input.truncated) {
    limitations.push("Inspection limits truncated part of the content.");
    limitations.push(...(input.truncationReasons ?? []));
  }

  return {
    findings: input.findings,
    assurance: "low",
    decision,
    reasons,
    limitations,
  };
}
