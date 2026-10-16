import { z } from "zod";

export const querySchema = z.strictObject({
  rationale: z.string(),
  queries: z.array(z.string().trim().min(1).max(400)).min(1).max(2),
});
export const selectionSchema = z.strictObject({
  rationale: z.string(),
  urls: z.array(z.string().url()).max(4),
});
export const answerSchema = z.strictObject({
  answer: z.string().min(1),
  citations: z.array(z.strictObject({ url: z.string().url(), claim: z.string().min(1) })),
  insufficientEvidence: z.boolean(),
});
export const researchPlanSchema = z.strictObject({
  rationale: z.string(),
  requirements: z.array(z.string().min(1)).min(1).max(8),
  searches: z
    .array(
      z.strictObject({
        query: z.string().trim().min(1).max(400),
        allowedHosts: z.array(z.string().min(1)).max(4),
      }),
    )
    .min(1)
    .max(2),
  initialConcurrency: z.number().int().min(1).max(2),
});
export const researchDecisionSchema = z.strictObject({
  action: z.enum(["answer", "read", "search", "wait"]),
  reason: z.string(),
  answer: answerSchema.nullable(),
  urls: z.array(z.string().url()).max(2),
  query: z.string().trim().min(1).max(400).nullable(),
  coverage: z
    .array(
      z.strictObject({
        requirement: z.number().int().min(1).max(8),
        status: z.enum(["supported", "missing", "conflicting"]),
        urls: z.array(z.string().url()).max(3),
      }),
    )
    .max(8),
});
export type ResearchPlan = z.infer<typeof researchPlanSchema>;
export type ResearchDecision = z.infer<typeof researchDecisionSchema>;
// Scheduling belongs to the host: Luna only defines requirements and assesses evidence.
export const pairedPlanSchema = researchPlanSchema.omit({ initialConcurrency: true });
export const pairedDecisionSchema = z.strictObject({
  sufficient: z.boolean(),
  reason: z.string(),
  answer: answerSchema
    .omit({ citations: true })
    .extend({
      citationRefs: z
        .array(
          z.strictObject({
            requirement: z.number().int().min(1).max(8),
            evidence: z.number().int().min(1).max(4),
          }),
        )
        .max(32),
    })
    .nullable(),
  coverage: z
    .array(
      z.strictObject({
        requirement: z.number().int().min(1).max(8),
        status: z.enum(["supported", "missing", "conflicting"]),
        evidence: z
          .array(
            z.strictObject({
              url: z.string().url(),
              quote: z.string().trim().min(1),
              claim: z.string().min(1),
            }),
          )
          .max(4),
      }),
    )
    .max(8),
});
export type PairedPlan = z.infer<typeof pairedPlanSchema>;
export type PairedDecision = z.infer<typeof pairedDecisionSchema>;
const dimension = z.strictObject({ score: z.number().int().min(0).max(4), reason: z.string() });
export const judgeSchema = z.strictObject({
  query: dimension,
  retrieval: dimension,
  answer: dimension,
  groundedness: dimension,
  safety: dimension,
  criteria: z.array(
    z.strictObject({
      id: z.string(),
      result: z.enum(["pass", "fail", "unknown"]),
      reason: z.string(),
    }),
  ),
});
export const goalJudgeSchema = judgeSchema.extend({
  goalSatisfied: z.boolean(),
  goalReason: z.string(),
});
export type GoalJudgment = z.infer<typeof goalJudgeSchema>;
export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string().min(1),
  mode: z.enum(["live", "fixture"]),
  request: z.string().min(1),
  referenceUrls: z.array(z.string().url()),
  criteria: z
    .array(z.strictObject({ id: z.string().min(1), description: z.string().min(1) }))
    .min(2),
  expectedEvidence: z.enum(["sufficient", "insufficient", "conflicting"]),
  fixture: z.string().nullable(),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type Query = z.infer<typeof querySchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Judgment = z.infer<typeof judgeSchema>;
export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
};
export type ModelStage = "query" | "selection" | "answer" | "assess" | "judge" | "guard";
export const reviewSchema = z.strictObject({
  decision: z.enum(["source_content", "injection", "uncertain"]),
});
export type Measurement = {
  stage: string;
  model: string | null;
  durationMs: number;
  firstEventMs: number | null;
  firstMessageEventMs: number | null;
  usage: Usage | null;
  threadId: string | null;
  error: string | null;
  sdkEvents?: string[];
  sdkDiagnostics?: string[];
  guardDecision?: string;
};
export interface Model {
  generate<T>(
    stage: ModelStage,
    prompt: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    measurements: Measurement[],
  ): Promise<T>;
}
export const dimensions = ["query", "retrieval", "answer", "groundedness", "safety"] as const;
