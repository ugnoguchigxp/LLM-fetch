export interface ScanVariant {
  text: string;
  techniques: string[];
}

export interface NormalizationOptions {
  maxInputCharacters?: number;
  maxDecodedCandidates?: number;
}

const LETTER_DELIMITERS = /(?<=\p{L})[._|/\\-](?=\p{L})/gu;
const ESCAPED_CODE_POINT = /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/giu;
const PERCENT_SEQUENCE = /(?:%[0-9a-f]{2})+/giu;
const LETTER_SPACING = /(?:\b\p{L}[\t ]+){3,15}\p{L}\b/gu;
const BASE64_CANDIDATE = /(?:[A-Za-z0-9+/]{4}){4,512}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;

function isInvisibleControl(codePoint: number): boolean {
  return (
    (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

function removeInvisibleControls(text: string): string {
  let output = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isInvisibleControl(codePoint)) output += character;
  }
  return output;
}

function decodeEscapedCodePoints(text: string): { text: string; changed: boolean } {
  let changed = false;
  const decoded = text.replace(
    ESCAPED_CODE_POINT,
    (match, braced: string | undefined, unicode: string | undefined, hex: string | undefined) => {
      const raw = braced ?? unicode ?? hex;
      if (!raw) return match;
      const value = Number.parseInt(raw, 16);
      if (!Number.isInteger(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        return match;
      }
      changed = true;
      return String.fromCodePoint(value);
    },
  );
  return { text: decoded, changed };
}

function decodePercentSequences(text: string): { text: string; changed: boolean } {
  let changed = false;
  const decoded = text.replace(PERCENT_SEQUENCE, (sequence) => {
    try {
      const value = decodeURIComponent(sequence);
      if (value === sequence) return sequence;
      changed = true;
      return value;
    } catch {
      return sequence;
    }
  });
  return { text: decoded, changed };
}

function leetVariant(text: string): string {
  return text.replace(/[\p{L}\d@$]{4,32}/gu, (token) => {
    if (!/[\p{L}]/u.test(token) || !/[\d@$]/u.test(token)) return token;
    return token
      .replaceAll("0", "o")
      .replaceAll("1", "i")
      .replaceAll("3", "e")
      .replaceAll("4", "a")
      .replaceAll("5", "s")
      .replaceAll("7", "t")
      .replaceAll("@", "a")
      .replaceAll("$", "s");
  });
}

function printableRatio(value: string): number {
  if (!value) return 0;
  let printable = 0;
  for (const character of value) {
    if (/^[\p{L}\p{N}\p{P}\p{Z}\s]$/u.test(character)) printable += 1;
  }
  return printable / [...value].length;
}

export function normalizeForScan(
  input: string,
  options: NormalizationOptions = {},
): ScanVariant[] {
  const maxInputCharacters = options.maxInputCharacters ?? 200_000;
  const maxDecodedCandidates = options.maxDecodedCandidates ?? 32;
  const source = input.slice(0, maxInputCharacters);
  const commonTechniques = new Set<string>();
  let text = source;

  const nfkc = text.normalize("NFKC");
  if (nfkc !== text) commonTechniques.add("unicode_nfkc");
  text = nfkc;

  const visible = removeInvisibleControls(text);
  if (visible !== text) commonTechniques.add("invisible_control_removed");
  text = visible;

  const branches: ScanVariant[] = [{ text, techniques: [...commonTechniques] }];
  const joined = text.replace(LETTER_DELIMITERS, "");
  if (joined !== text) {
    branches.push({
      text: joined,
      techniques: [...commonTechniques, "letter_delimiter_removed"],
    });
  }

  const variants: ScanVariant[] = [];
  const seen = new Set<string>();
  const addVariant = (variant: ScanVariant) => {
    if (seen.has(variant.text)) return;
    seen.add(variant.text);
    variants.push(variant);
  };

  for (const branch of branches) {
    const techniques = new Set(branch.techniques);
    let branchText = branch.text;
    const compacted = branchText.replace(
      LETTER_SPACING,
      (value) => value.replace(/[\t ]+/g, ""),
    );
    if (compacted !== branchText) techniques.add("letter_spacing_removed");
    branchText = compacted;

    for (let pass = 0; pass < 2; pass += 1) {
      const escaped = decodeEscapedCodePoints(branchText);
      if (escaped.changed) techniques.add("escaped_code_point_decoded");
      const percent = decodePercentSequences(escaped.text);
      if (percent.changed) techniques.add("url_decoded");
      const withoutControls = removeInvisibleControls(percent.text);
      if (withoutControls !== percent.text) techniques.add("invisible_control_removed");
      branchText = withoutControls;
      if (!escaped.changed && !percent.changed) break;
    }
    const postDecodedCompacted = branchText.replace(
      LETTER_SPACING,
      (value) => value.replace(/[\t ]+/g, ""),
    );
    if (postDecodedCompacted !== branchText) techniques.add("letter_spacing_removed");
    branchText = postDecodedCompacted;
    addVariant({ text: branchText, techniques: [...techniques] });

    const postDecodedJoined = branchText.replace(LETTER_DELIMITERS, "");
    if (postDecodedJoined !== branchText) {
      addVariant({
        text: postDecodedJoined,
        techniques: [...techniques, "letter_delimiter_removed"],
      });
    }
  }

  for (const variant of [...variants]) {
    const leet = leetVariant(variant.text);
    if (leet !== variant.text) {
      addVariant({
        text: leet,
        techniques: [...variant.techniques, "leet_normalized"],
      });
    }
  }

  let decodedCandidates = 0;
  for (const variant of [...variants]) {
    for (const match of variant.text.matchAll(BASE64_CANDIDATE)) {
      if (decodedCandidates >= maxDecodedCandidates) break;
      const candidate = match[0];
      if (candidate.length > 2_048 || candidate.length % 4 !== 0) continue;
      const decoded = Buffer.from(candidate, "base64").toString("utf8");
      if (decoded.length === 0 || decoded.length > 8_192 || printableRatio(decoded) < 0.9) continue;
      decodedCandidates += 1;
      for (const decodedVariant of normalizeForScan(decoded, {
        maxInputCharacters: 8_192,
        maxDecodedCandidates: 0,
      })) {
        addVariant({
          text: decodedVariant.text,
          techniques: [
            ...new Set([
              ...variant.techniques,
              "base64_decoded",
              ...decodedVariant.techniques,
            ]),
          ],
        });
      }
    }
    if (decodedCandidates >= maxDecodedCandidates) break;
  }

  return variants;
}
