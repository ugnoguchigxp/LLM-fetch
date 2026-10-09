import type { GuardReasonCode, GuardScanDiagnostics } from "../contracts.js";

export const GUARD_REASON_CODES = [
  "PATTERN_DETECTED",
  "SEGMENT_COUNT_LIMIT",
  "CHARACTER_BUDGET_LIMIT",
  "SEGMENT_TEXT_LIMIT",
  "SEGMENT_COLLECTION_LIMIT",
  "INSPECTION_INCOMPLETE",
  "ADDITIONAL_GUARD_RESTRICTION",
] as const satisfies readonly GuardReasonCode[];

const DIAGNOSTIC_STAGES = new Set(["content", "reference", "search_result"]);
const DIAGNOSTIC_FIELDS = [
  "segmentCount",
  "selectedSegmentCount",
  "scannedSegmentCount",
  "availableCharacters",
  "scannedCharacters",
  "maxSegments",
  "maxCharacters",
  "omittedSegments",
] as const satisfies readonly (keyof GuardScanDiagnostics)[];

export function orderGuardReasonCodes(codes: readonly GuardReasonCode[]): GuardReasonCode[] {
  const present = new Set(codes);
  return GUARD_REASON_CODES.filter((code) => present.has(code));
}

export function freezeGuardReasonCodes(
  codes: readonly GuardReasonCode[],
): readonly GuardReasonCode[] {
  return Object.freeze(orderGuardReasonCodes(codes));
}

function safeCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

export function sanitizeGuardReasonCodes(value: unknown): readonly GuardReasonCode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return Object.freeze([]);
  const present = new Set<GuardReasonCode>();
  for (const item of value) {
    if (typeof item === "string" && (GUARD_REASON_CODES as readonly string[]).includes(item)) {
      present.add(item as GuardReasonCode);
    }
  }
  return Object.freeze(GUARD_REASON_CODES.filter((code) => present.has(code)));
}

export function sanitizeGuardDiagnostics(
  value: unknown,
): readonly GuardScanDiagnostics[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return Object.freeze([]);
  const diagnostics: GuardScanDiagnostics[] = [];
  for (const item of value) {
    if (diagnostics.length >= 8) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.stage !== "string" || !DIAGNOSTIC_STAGES.has(record.stage)) continue;
    const diagnostic = { stage: record.stage } as GuardScanDiagnostics;
    let valid = true;
    for (const field of DIAGNOSTIC_FIELDS) {
      const count = safeCount(record[field]);
      if (count === undefined) {
        valid = false;
        break;
      }
      diagnostic[field] = count;
    }
    if (!valid) continue;
    diagnostics.push(Object.freeze(diagnostic));
  }
  return Object.freeze(diagnostics);
}

export function copyGuardDiagnostics(
  diagnostics: readonly GuardScanDiagnostics[],
): readonly GuardScanDiagnostics[] {
  return Object.freeze(
    diagnostics.map((diagnostic) =>
      Object.freeze({
        stage: diagnostic.stage,
        segmentCount: diagnostic.segmentCount,
        selectedSegmentCount: diagnostic.selectedSegmentCount,
        scannedSegmentCount: diagnostic.scannedSegmentCount,
        availableCharacters: diagnostic.availableCharacters,
        scannedCharacters: diagnostic.scannedCharacters,
        maxSegments: diagnostic.maxSegments,
        maxCharacters: diagnostic.maxCharacters,
        omittedSegments: diagnostic.omittedSegments,
      }),
    ),
  );
}
