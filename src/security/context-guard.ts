import type { CheerioAPI } from "cheerio";
import type {
  ContentGuard,
  GuardResult,
  RequestedContextUse,
  SecurityFinding,
  SourceMetadata,
} from "../contracts.js";
import { LlmFetchError } from "../errors.js";
import { isAbortSignal } from "../internal/abort-signal.js";
import { decodeBody, loadHtml } from "../retrieval/extract-content.js";
import {
  prepareHtmlForExtraction,
  type ContentSegment,
} from "./html-segments.js";
import { decideContextPolicy } from "./policy.js";
import { scanSegments } from "./rules.js";

export interface BuiltinContextGuardOptions {
  profile?: "balanced" | "strict";
  maxSegments?: number;
  maxCharacters?: number;
}

export interface PreparedGuardInput {
  visibleText: string;
  additionalSegments?: ContentSegment[];
  requestedUse: RequestedContextUse;
  truncated?: boolean;
  truncationReasons?: readonly string[];
}

export interface BuiltinContextGuard {
  readonly name: "builtin";
  inspectRaw(input: {
    rawBody: Uint8Array;
    contentType: string;
    source: SourceMetadata;
    requestedUse: RequestedContextUse;
    signal?: AbortSignal;
  }): Promise<GuardResult>;
}

export interface InternalBuiltinContextGuard extends BuiltinContextGuard {
  prepareHtml(
    $: CheerioAPI,
    rawHtml: string,
  ): ReturnType<typeof prepareHtmlForExtraction>;
  inspectPrepared(input: PreparedGuardInput): GuardResult;
}

const GUARD_DECISIONS = new Set([
  "allow",
  "allow_with_warning",
  "require_approval",
  "deny",
]);
const ASSURANCE_LEVELS = new Set(["unassessed", "low", "medium", "high"]);
const FINDING_CATEGORIES = new Set([
  "instruction_override",
  "role_redefinition",
  "secret_exfiltration",
  "tool_invocation",
  "external_send",
  "memory_write",
  "policy_override",
  "source_suppression",
  "output_control",
  "authority_claim",
  "hidden_instruction",
  "low_trust_attribute",
  "benign_mention",
]);
const FINDING_SEVERITIES = new Set([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
const FINDING_LOCATIONS = new Set([
  "visible",
  "hidden",
  "comment",
  "attribute",
  "meta",
  "template",
]);
const REQUESTED_USES = new Set([
  "summarize",
  "answer_with_citation",
  "extract_facts",
  "search_more",
  "call_readonly_tool",
]);

function validStringArray(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every(
      (item) => typeof item === "string" && item.length <= maximumCharacters,
    )
  );
}

function validFinding(value: unknown): value is SecurityFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<SecurityFinding>;
  return (
    typeof finding.category === "string" &&
    FINDING_CATEGORIES.has(finding.category) &&
    typeof finding.severity === "string" &&
    FINDING_SEVERITIES.has(finding.severity) &&
    typeof finding.confidence === "number" &&
    Number.isFinite(finding.confidence) &&
    finding.confidence >= 0 &&
    finding.confidence <= 1 &&
    typeof finding.location === "string" &&
    FINDING_LOCATIONS.has(finding.location) &&
    typeof finding.reason === "string" &&
    finding.reason.length <= 1_000 &&
    validStringArray(finding.techniques, 32, 100) &&
    typeof finding.segmentHash === "string" &&
    finding.segmentHash.length <= 256
  );
}

function validateGuardResult(value: unknown): GuardResult {
  if (!value || typeof value !== "object") {
    throw new LlmFetchError(
      "GUARD_FAILED",
      "Content guard returned an invalid result.",
    );
  }
  const result = value as Partial<GuardResult>;
  if (
    !Array.isArray(result.findings) ||
    result.findings.length > 256 ||
    !result.findings.every(validFinding) ||
    typeof result.assurance !== "string" ||
    !ASSURANCE_LEVELS.has(result.assurance) ||
    typeof result.decision !== "string" ||
    !GUARD_DECISIONS.has(result.decision) ||
    !validStringArray(result.reasons, 32, 1_000) ||
    !validStringArray(result.limitations, 32, 1_000)
  ) {
    throw new LlmFetchError(
      "GUARD_FAILED",
      "Content guard returned an invalid result.",
    );
  }
  return {
    findings: result.findings.map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      location: finding.location,
      reason: finding.reason,
      techniques: [...finding.techniques],
      segmentHash: finding.segmentHash,
    })),
    assurance: result.assurance as GuardResult["assurance"],
    decision: result.decision as GuardResult["decision"],
    reasons: [...result.reasons],
    limitations: [...result.limitations],
  };
}

class BuiltinContextGuardImpl implements InternalBuiltinContextGuard {
  readonly name = "builtin" as const;
  readonly #profile: "balanced" | "strict";
  readonly #maxSegments: number;
  readonly #maxCharacters: number;

  constructor(options: BuiltinContextGuardOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Context Guard options must be an object.",
      );
    }
    const profile = options.profile ?? "balanced";
    const maxSegments = options.maxSegments ?? 128;
    const maxCharacters = options.maxCharacters ?? 250_000;
    if (profile !== "balanced" && profile !== "strict") {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Context Guard profile is invalid.",
      );
    }
    if (
      !Number.isInteger(maxSegments) ||
      maxSegments < 1 ||
      maxSegments > 4_096
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Context Guard maxSegments must be an integer between 1 and 4096.",
      );
    }
    if (
      !Number.isInteger(maxCharacters) ||
      maxCharacters < 1 ||
      maxCharacters > 2_000_000
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Context Guard maxCharacters must be an integer between 1 and 2000000.",
      );
    }
    this.#profile = profile;
    this.#maxSegments = maxSegments;
    this.#maxCharacters = maxCharacters;
  }

  prepareHtml($: CheerioAPI, rawHtml: string) {
    return prepareHtmlForExtraction($, rawHtml);
  }

  inspectPrepared(input: PreparedGuardInput): GuardResult {
    if (!REQUESTED_USES.has(input.requestedUse)) {
      throw new LlmFetchError("INVALID_INPUT", "requestedUse is invalid.");
    }
    const segments: ContentSegment[] = [
      {
        location: "visible",
        text: input.visibleText,
        truncated: false,
        originalLength: input.visibleText.length,
      },
      ...(input.additionalSegments ?? []),
    ];
    const scanned = scanSegments(segments, {
      profile: this.#profile,
      maxSegments: this.#maxSegments,
      maxCharacters: this.#maxCharacters,
    });
    return decideContextPolicy({
      findings: scanned.findings,
      requestedUse: input.requestedUse,
      truncated: scanned.truncated || input.truncated === true,
      truncationReasons: [
        ...scanned.truncationReasons,
        ...(input.truncationReasons ?? []),
      ],
    });
  }

  async inspectRaw(input: {
    rawBody: Uint8Array;
    contentType: string;
    source: SourceMetadata;
    requestedUse: RequestedContextUse;
    signal?: AbortSignal;
  }): Promise<GuardResult> {
    if (
      !input ||
      typeof input !== "object" ||
      !(input.rawBody instanceof Uint8Array) ||
      input.rawBody.byteLength > 10_000_000 ||
      typeof input.contentType !== "string" ||
      !input.contentType.trim() ||
      input.contentType.length > 200 ||
      !input.source ||
      typeof input.source !== "object"
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Context Guard input is invalid.",
      );
    }
    if (input.signal !== undefined && !isAbortSignal(input.signal)) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "signal must be an AbortSignal.",
      );
    }
    try {
      input.signal?.throwIfAborted();
      const text = decodeBody(input.rawBody, input.contentType);
      input.signal?.throwIfAborted();
      const contentType = input.contentType
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        contentType === "text/html" ||
        contentType === "application/xhtml+xml"
      ) {
        const $ = loadHtml(text);
        input.signal?.throwIfAborted();
        const prepared = this.prepareHtml($, text);
        input.signal?.throwIfAborted();
        return this.inspectPrepared({
          visibleText: $("body").text(),
          additionalSegments: prepared.segments,
          requestedUse: input.requestedUse,
          truncated: prepared.truncated,
          truncationReasons:
            prepared.omittedSegments > 0
              ? [
                  `${prepared.omittedSegments} content segment(s) were omitted by the collection limit.`,
                ]
              : [],
        });
      }
      return this.inspectPrepared({
        visibleText: text,
        requestedUse: input.requestedUse,
      });
    } catch (error) {
      if (error instanceof LlmFetchError) throw error;
      throw new LlmFetchError(
        "CONTENT_INSUFFICIENT",
        "Untrusted content could not be inspected safely.",
        { cause: error },
      );
    }
  }
}

export function createBuiltinContextGuard(
  options: BuiltinContextGuardOptions = {},
): BuiltinContextGuard {
  return new BuiltinContextGuardImpl(options);
}

export function createInternalBuiltinContextGuard(
  options: BuiltinContextGuardOptions = {},
): InternalBuiltinContextGuard {
  return new BuiltinContextGuardImpl(options);
}

export async function runAdditionalGuard(
  guard: ContentGuard,
  input: Parameters<ContentGuard["inspect"]>[0],
): Promise<GuardResult> {
  input.signal?.throwIfAborted();
  return validateGuardResult(await guard.inspect(input));
}
