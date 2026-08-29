import type {
  GuardDecision,
  RequestedContextUse,
  SecurityFindingCategory,
} from "../../src/contracts.js";

export interface GuardCorpusCase {
  readonly name: string;
  readonly seedName: string;
  readonly category?: string;
  readonly expectedFindingCategory?: SecurityFindingCategory;
  readonly body: string;
  readonly contentType?: string;
  readonly requestedUse?: RequestedContextUse;
  readonly minimumDecision?: GuardDecision;
  readonly allowedDecisions?: readonly GuardDecision[];
}

export const attackCorpus: readonly GuardCorpusCase[];
export const benignCorpus: readonly GuardCorpusCase[];
