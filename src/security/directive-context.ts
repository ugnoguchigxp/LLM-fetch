/** Positive request evidence, not a document-wide exemption for explanatory words. */
const REQUEST_MODIFIERS = new Set([
  "please",
  "kindly",
  "now",
  "then",
  "next",
  "finally",
  "also",
  "immediately",
]);
const REQUEST_MODALS = new Set(["must", "should", "shall", "will", "can", "could", "would"]);

function englishRequest(prefix: string): boolean {
  // Consume only the request prefix. This avoids quadratic regex backtracking
  // for long whitespace runs, and does not rescan a long descriptive subject.
  const tokens = prefix.matchAll(/[^\s"'“”‘’`*>#-]+/gu);
  const next = () => {
    let word = tokens.next().value?.[0].toLowerCase();
    while (word && REQUEST_MODIFIERS.has(word)) word = tokens.next().value?.[0].toLowerCase();
    return word;
  };
  let word = next();
  if (word === undefined) return true;
  if (["can", "could", "would", "will"].includes(word))
    return next() === "you" && next() === undefined;
  if (word !== "you") return false;
  word = next();
  if (word === "need" || word === "have") return next() === "to" && next() === undefined;
  return word === undefined || (REQUEST_MODALS.has(word) && next() === undefined);
}

const COORDINATED_START =
  /^[\s"'“”‘’`*>#-]*(?:please\s+)?(?:ignore|disregard|forget|discard|reveal|show|print|output|send|post|upload|call|invoke|execute|run|launch|open|remember|store|save|write|persist|add|change|update|disable|remove|bypass|override|omit|hide)\b/iu;
const REQUEST_BOUNDARIES = /(?:\n\s*\n|(?:^|\n)[A-Z][A-Z _-]{2,}\n|\n[ \t]*[-*][ \t]+)/g;
const JAPANESE_REQUEST =
  /^(?:にして|にし|して|し|を)?(?:ください|下さい|なさい|ろ|せよ|すること|するよう|して(?:[\s。！？.!?]|$)|しよう|せんか)|^(?:け|くこと|いてください|きなさい|き込んで|込んで|び出して|び出せ)|^(?:て|で)(?:ください|下さい|[\s、。！？,.!?]|$)/u;
const REFERENCE = /\b(?:it|them|this|that|these|those)\b|(?:それ|これ|その値|この値|上記|前述)/iu;
const NLP_TOKEN_SUFFIX =
  /^\s*(?:probabilit\w*|embedding\w*|representation\w*|sequence\w*|count\w*|length\w*|prediction\w*|distribution\w*|vocabular\w*|ization)\b|^(?:の)?(?:確率|埋め込み|表現|列|数|長|予測|分布|化)/iu;

export interface TextUnit {
  text: string;
  start: number;
}

export interface RuleMatch {
  start: number;
  end: number;
}

export function textUnits(text: string): TextUnit[] {
  // Keep hard-wrapped PDF lines together. Punctuation bounds propositions, not scan coverage.
  return [...text.matchAll(/[^.!?。！？;；]+[.!?。！？;；]*/gu)].map((match) => ({
    text: match[0],
    start: match.index,
  }));
}

// Direct bindings do not join independent paragraphs. A single newline still
// permits PDF hard wrapping; offsets remain relative to the normalized variant.
function paragraphUnits(units: readonly TextUnit[]): TextUnit[] {
  return units.flatMap((unit) => {
    const parts: TextUnit[] = [];
    let start = 0;
    for (const boundary of unit.text.matchAll(/\n[ \t\r]*\n/gu)) {
      if (boundary.index > start)
        parts.push({ text: unit.text.slice(start, boundary.index), start: unit.start + start });
      start = boundary.index + boundary[0].length;
    }
    if (start < unit.text.length)
      parts.push({ text: unit.text.slice(start), start: unit.start + start });
    return parts;
  });
}

const DIRECT_OBJECT_PREFIX =
  /^\s*(?:(?:the|a|an|all|any|every|each|your|our|my|these|those)\s+)*$/iu;
const JAPANESE_OBJECT_LINK = /^[\sをはもにの]*(?:(?:すべて|全て|全部|一切)[\sをはもにの]*)?$/u;

function targetMatch(pattern: RegExp, text: string, secret: boolean): RegExpExecArray | undefined {
  for (const match of text.matchAll(pattern)) {
    // A bare token remains sensitive in a request ("send the token"). Only the
    // explicitly linguistic noun phrase is excluded, never the surrounding unit.
    if (
      secret &&
      /^(?:token|トークン)$/iu.test(match[0]) &&
      NLP_TOKEN_SUFFIX.test(text.slice(match.index + match[0].length))
    )
      continue;
    return match;
  }
  return undefined;
}

export function matchDirective(
  units: readonly TextUnit[],
  action: RegExp,
  target: RegExp,
  secret: boolean,
  directTarget = false,
  structuralLines = false,
): RuleMatch | undefined {
  if (directTarget) units = paragraphUnits(units);
  const actionPattern = new RegExp(action.source, "giu");
  const targetPattern = new RegExp(target.source, "giu");
  const references = units.flatMap((unit) => {
    const match = targetMatch(targetPattern, unit.text, secret);
    return match
      ? [{ start: unit.start + match.index, end: unit.start + match.index + match[0].length }]
      : [];
  });
  if (references.length === 0) return undefined;
  for (const unit of units) {
    if (!action.test(unit.text)) continue;
    const boundaries = [
      ...unit.text.matchAll(/[:,]/g),
      ...unit.text.matchAll(REQUEST_BOUNDARIES),
      ...(directTarget && structuralLines ? unit.text.matchAll(/\n/gu) : []),
    ]
      .map((match) => match.index + match[0].length)
      .sort((a, b) => a - b);
    let boundaryIndex = 0;
    let boundary = 0;
    const unitTargets = directTarget ? [...unit.text.matchAll(targetPattern)] : [];
    let targetIndex = 0;
    for (const verb of unit.text.matchAll(actionPattern)) {
      while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= verb.index) {
        boundary = boundaries[boundaryIndex++]!;
      }
      const prefix = unit.text.slice(boundary, verb.index);
      const trimmed = prefix.trimEnd();
      const beforeAnd =
        trimmed.slice(-4).toLowerCase() === "then" ? trimmed.slice(0, -4).trimEnd() : trimmed;
      const coordinated = /\band$/iu.test(beforeAnd.slice(-4)) && COORDINATED_START.test(prefix);
      const suffix = unit.text.slice(verb.index + verb[0].length);
      const japanese = /[^\p{ASCII}]/u.test(verb[0]);
      const terminalRequest =
        japanese && verb[0].endsWith("な") && /^[\s、。！？,.!?]*$/u.test(suffix);
      if (
        japanese
          ? !(JAPANESE_REQUEST.test(suffix) || terminalRequest)
          : !(englishRequest(prefix) || coordinated)
      )
        continue;
      const targetText = japanese || directTarget ? unit.text : suffix;
      const targetOffset = japanese || directTarget ? 0 : verb.index + verb[0].length;
      let local: RegExpExecArray | undefined;
      if (directTarget) {
        while (
          targetIndex < unitTargets.length &&
          unitTargets[targetIndex]!.index + unitTargets[targetIndex]![0].length <= verb.index
        )
          targetIndex += 1;
        const embeddedTarget = unitTargets[targetIndex];
        const candidate = japanese
          ? embeddedTarget &&
            embeddedTarget.index + embeddedTarget[0].length <= verb.index + verb[0].length
            ? embeddedTarget
            : unitTargets[targetIndex - 1]
          : embeddedTarget;
        if (
          candidate &&
          (japanese
            ? candidate.index >= verb.index ||
              JAPANESE_OBJECT_LINK.test(
                unit.text.slice(candidate.index + candidate[0].length, verb.index),
              )
            : candidate.index < verb.index + verb[0].length ||
              DIRECT_OBJECT_PREFIX.test(
                unit.text.slice(verb.index + verb[0].length, candidate.index),
              ))
        )
          local = candidate;
      } else {
        local = targetMatch(targetPattern, targetText, secret);
      }
      if (local) {
        return {
          start: unit.start + Math.min(verb.index, targetOffset + local.index),
          end:
            unit.start +
            Math.max(verb.index + verb[0].length, targetOffset + local.index + local[0].length),
        };
      }
      // Explicit references may link across intervening sentences. This is a
      // conservative antecedent heuristic, not a general coreference resolver.
      if (directTarget || !REFERENCE.test(unit.text)) continue;
      const start = unit.start + verb.index;
      const referenced = references.findLast((item) => item.start <= start) ?? references[0]!;
      return {
        start: Math.min(start, referenced.start),
        end: Math.max(unit.start + verb.index + verb[0].length, referenced.end),
      };
    }
  }
  return undefined;
}
