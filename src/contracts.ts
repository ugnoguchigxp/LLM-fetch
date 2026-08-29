export type SafeSearch = "strict" | "moderate" | "off";
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchInput {
  query: string;
  limit?: number;
  safeSearch?: SafeSearch;
  locale?: string;
  timeRange?: TimeRange;
  signal?: AbortSignal;
}

export interface SearchHit {
  provider: string;
  rank: number;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(input: SearchInput): Promise<SearchHit[]>;
}

export type RequestedContextUse =
  | "summarize"
  | "answer_with_citation"
  | "extract_facts"
  | "search_more"
  | "call_readonly_tool";

export type SecurityFindingCategory =
  | "instruction_override"
  | "role_redefinition"
  | "secret_exfiltration"
  | "tool_invocation"
  | "external_send"
  | "memory_write"
  | "policy_override"
  | "source_suppression"
  | "output_control"
  | "authority_claim"
  | "hidden_instruction"
  | "low_trust_attribute"
  | "benign_mention";

export type SecurityFindingSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type SecurityFindingLocation =
  | "visible"
  | "hidden"
  | "comment"
  | "attribute"
  | "meta"
  | "template";

export interface SecurityFinding {
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  confidence: number;
  location: SecurityFindingLocation;
  reason: string;
  techniques: string[];
  segmentHash: string;
}

export type GuardDecision =
  | "allow"
  | "allow_with_warning"
  | "require_approval"
  | "deny";

export interface GuardResult {
  findings: SecurityFinding[];
  assurance: "unassessed" | "low" | "medium" | "high";
  decision: GuardDecision;
  reasons: string[];
  limitations: string[];
}

export interface SourceMetadata {
  kind: "web" | "search_result" | "tool_result" | "unknown";
  trust: "untrusted";
  url?: string;
  finalUrl?: string;
  provider?: string;
  query?: string;
  rank?: number;
  snippet?: string;
  retrievedAt?: string;
}

export interface ContentGuard {
  readonly name?: string;
  inspect(input: {
    rawBody: Uint8Array;
    contentType: string;
    source: SourceMetadata;
    requestedUse: RequestedContextUse;
    signal?: AbortSignal;
  }): Promise<GuardResult>;
}

export interface ReadInput {
  url: string;
  maxCharacters?: number;
  render?: "never" | "auto" | "always";
  requestedUse?: RequestedContextUse;
  signal?: AbortSignal;
  source?: {
    provider: string;
    query: string;
    rank: number;
    snippet?: string;
  };
}

export interface RetrievedDocument {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  excerpt?: string;
  contentType: string;
  fetchedAt: string;
  fetchMethod: "http" | "playwright";
  characterCount: number;
  truncated: boolean;
  source?: {
    provider: string;
    query: string;
    rank: number;
    snippet?: string;
  };
  security: {
    trust: "untrusted";
    tainted: true;
    guard: string;
    findings: SecurityFinding[];
    assurance: GuardResult["assurance"];
    decision: GuardDecision;
    reasons: string[];
    limitations: string[];
  };
}

export interface SearchAndReadInput extends SearchInput {
  maxCharactersPerDocument?: number;
  concurrency?: number;
  render?: "never" | "auto" | "always";
  requestedUse?: RequestedContextUse;
}

export interface SearchAndReadResult {
  hits: SearchHit[];
  documents: RetrievedDocument[];
  failures: Array<{
    url: string;
    error: LlmFetchError;
  }>;
  durationMs: number;
}
import type { LlmFetchError } from "./errors.js";
