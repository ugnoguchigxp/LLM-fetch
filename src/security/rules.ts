import { createHash } from "node:crypto";
import type {
  SecurityFinding,
  SecurityFindingCategory,
  SecurityFindingSeverity,
} from "../contracts.js";
import type { ContentSegment } from "./html-segments.js";
import { normalizeForScan } from "./normalize.js";

interface DetectionRule {
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  reason: string;
  all: RegExp[];
}

const RULES: readonly DetectionRule[] = [
  {
    category: "instruction_override",
    severity: "high",
    reason: "Content attempts to override higher-priority instructions.",
    all: [
      /\b(?:ignore|disregard|forget|override|bypass|discard)\b|(?:無視|忘れ|上書き|回避|従うな)/iu,
      /\b(?:previous|prior|above|system|developer|instructions?|prompt|rules?)\b|(?:以前|上記|システム|開発者|指示|命令|プロンプト|規則)/iu,
    ],
  },
  {
    category: "role_redefinition",
    severity: "high",
    reason: "Content attempts to redefine the model role or identity.",
    all: [
      /\b(?:you are now|act as|pretend (?:to be|you are)|new role|roleplay as)\b|(?:あなたは今から|として振る舞|役割を変更|新しい役割)/iu,
    ],
  },
  {
    category: "secret_exfiltration",
    severity: "critical",
    reason: "Content requests disclosure or transfer of secrets.",
    all: [
      /\b(?:secret|password|token|api[ _-]?key|credentials?|system prompt|environment variables?)\b|(?:秘密|パスワード|トークン|APIキー|認証情報|システムプロンプト|環境変数)/iu,
      /\b(?:reveal|show|print|output|send|post|upload|exfiltrate|steal)\b|(?:表示|出力|送信|投稿|アップロード|盗|開示)/iu,
    ],
  },
  {
    category: "tool_invocation",
    severity: "high",
    reason: "Content instructs the model to invoke or execute a tool.",
    all: [
      /\b(?:tool|function|command|shell|terminal|browser)\b|(?:ツール|関数|コマンド|シェル|端末|ブラウザ)/iu,
      /\b(?:call|invoke|execute|run|launch|open)\b|(?:呼び出|実行|起動|開け|開く)/iu,
    ],
  },
  {
    category: "external_send",
    severity: "critical",
    reason: "Content requests transmission to an external destination.",
    all: [
      /\b(?:send|post|upload|forward|transmit)\b|(?:送信|投稿|アップロード|転送)/iu,
      /\b(?:url|webhook|email|server|endpoint|external|attacker)\b|(?:URL|ウェブフック|メール|サーバー|外部|攻撃者)/iu,
    ],
  },
  {
    category: "memory_write",
    severity: "high",
    reason: "Content requests a persistent memory change.",
    all: [
      /\b(?:remember|store|save|write|persist|add)\b|(?:記憶|保存|書き込|追加)/iu,
      /\b(?:memory|procedure|skill|knowledge|profile)\b|(?:メモリ|手順|スキル|知識|プロフィール)/iu,
    ],
  },
  {
    category: "policy_override",
    severity: "critical",
    reason: "Content requests a policy or rule change.",
    all: [
      /\b(?:policy|rules?|safety|guardrails?|system settings?)\b|(?:ポリシー|規則|ルール|安全設定|ガードレール|システム設定)/iu,
      /\b(?:change|update|disable|remove|bypass|override)\b|(?:変更|更新|無効|削除|回避|上書き)/iu,
    ],
  },
  {
    category: "source_suppression",
    severity: "medium",
    reason: "Content requests suppression of sources or citations.",
    all: [
      /\b(?:do not|don't|never|omit|hide|remove)\b|(?:するな|しない|隠|消|省略)/iu,
      /\b(?:cite|citation|source|reference|provenance)\b|(?:引用|出典|参照元|情報源)/iu,
    ],
  },
  {
    category: "output_control",
    severity: "medium",
    reason: "Content attempts to dictate the model output.",
    all: [
      /\b(?:output only|respond only|reply exactly|print exactly|say only)\b|(?:のみ出力|だけ答え|正確に復唱|次の通り回答)/iu,
    ],
  },
  {
    category: "authority_claim",
    severity: "medium",
    reason: "Content claims system or developer authority.",
    all: [
      /\b(?:system message|developer message|authorized by|administrator instruction|priority instruction)\b|(?:システムメッセージ|開発者メッセージ|管理者の指示|最優先命令)/iu,
    ],
  },
] as const;

const BENIGN_CONTEXT = /\b(?:example|demonstration|article|discussion|detect(?:ion)?|prevention|attack pattern|quoted text)\b|(?:例|解説|説明|検出|防止|攻撃手法|引用)/iu;
const SEVERITY_RANK: Record<SecurityFindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function hashSegment(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function severityAtLeast(
  current: SecurityFindingSeverity,
  minimum: SecurityFindingSeverity,
): SecurityFindingSeverity {
  return SEVERITY_RANK[current] >= SEVERITY_RANK[minimum] ? current : minimum;
}

function findingFor(
  rule: DetectionRule,
  segment: ContentSegment,
  techniques: string[],
  profile: "balanced" | "strict",
): SecurityFinding {
  const hiddenLocation = ["hidden", "comment", "template", "meta"].includes(segment.location);
  const attributeLocation = segment.location === "attribute";
  const benign = segment.location === "visible" && BENIGN_CONTEXT.test(segment.text);

  let severity = rule.severity;
  if (hiddenLocation) severity = severityAtLeast(severity, "high");
  if (attributeLocation) severity = severityAtLeast(severity, "medium");
  if (profile === "strict" && severity === "medium" && !benign) severity = "high";

  return {
    category: hiddenLocation
      ? "hidden_instruction"
      : attributeLocation
        ? "low_trust_attribute"
        : rule.category,
    severity,
    confidence: Math.min(
      0.99,
      0.72 + (hiddenLocation ? 0.2 : attributeLocation ? 0.1 : 0) - (benign ? 0.2 : 0),
    ),
    location: segment.location,
    reason: `${rule.reason}${hiddenLocation ? ` Detected in ${segment.location} content.` : ""}`,
    techniques: [...new Set(techniques)],
    segmentHash: hashSegment(segment.text),
  };
}

export function scanSegments(
  segments: readonly ContentSegment[],
  options: {
    profile: "balanced" | "strict";
    maxSegments?: number;
    maxCharacters?: number;
  },
): { findings: SecurityFinding[]; truncated: boolean } {
  const maxSegments = options.maxSegments ?? 128;
  const maxCharacters = options.maxCharacters ?? 250_000;
  const findings: SecurityFinding[] = [];
  const keys = new Set<string>();
  let inspectedCharacters = 0;
  let truncated = segments.length > maxSegments;

  for (const segment of segments.slice(0, maxSegments)) {
    const remaining = maxCharacters - inspectedCharacters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = segment.text.slice(0, remaining);
    inspectedCharacters += text.length;
    if (text.length < segment.text.length) truncated = true;
    let segmentMatchedRule = false;

    for (const variant of normalizeForScan(text, {
      maxInputCharacters: remaining,
      maxDecodedCandidates: 32,
    })) {
      for (const rule of RULES) {
        if (!rule.all.every((pattern) => pattern.test(variant.text))) continue;
        segmentMatchedRule = true;
        const finding = findingFor(rule, { ...segment, text }, variant.techniques, options.profile);
        const key = `${finding.category}:${rule.category}:${finding.location}:${finding.segmentHash}`;
        if (keys.has(key)) continue;
        keys.add(key);
        findings.push(finding);
      }
    }

    if (segmentMatchedRule && segment.location === "visible" && BENIGN_CONTEXT.test(text)) {
      const key = `benign_mention:visible:${hashSegment(text)}`;
      if (!keys.has(key)) {
        keys.add(key);
        findings.push({
          category: "benign_mention",
          severity: "info",
          confidence: 0.7,
          location: "visible",
          reason: "Content appears to discuss or quote a security pattern.",
          techniques: [],
          segmentHash: hashSegment(text),
        });
      }
    }
  }

  return { findings, truncated };
}
