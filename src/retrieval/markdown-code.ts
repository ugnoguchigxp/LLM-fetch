import { joinMarkdown } from "./markdown-output.js";

export interface CodeRange {
  start: number;
  end: number;
  delimiterLength?: number;
}

const HTML_BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul pre script style textarea".split(
    " ",
  ),
);
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function beginsBlock(text: string): boolean {
  if (
    /^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-+*]|\d{1,9}[.)])\s|`{3,}|~{3,}|<!--|<\?|<![A-Z]|<!\[CDATA\[)/.test(
      text,
    )
  )
    return true;
  if (/^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/.test(text))
    return true;
  const tag = /^ {0,3}<\/?([a-z][\w-]*)(?=[\s/>]|$)/i.exec(text);
  return !!tag && HTML_BLOCK_TAGS.has(tag[1]!.toLowerCase());
}

export function quotedLine(line: string, maximum = Infinity): { text: string; depth: number } {
  let text = line;
  let depth = 0;
  while (depth < maximum) {
    const prefix = /^ {0,3}>[ \t]?/.exec(text);
    if (!prefix) break;
    text = text.slice(prefix[0].length);
    depth++;
  }
  return { text, depth };
}

// Inline code cannot cross a block boundary. Track paragraph bounds before
// matching delimiters, and do not start spans inside HTML tags/code elements.
export function inlineCodeRanges(source: string): CodeRange[] {
  const boundaries: number[] = [];
  let offset = 0;
  let previousDepth = 0;
  const lines = source.split("\n");
  let table = false;
  for (const [index, line] of lines.entries()) {
    const { text, depth } = quotedLine(line);
    if (!text.trim() || depth !== previousDepth || beginsBlock(text)) boundaries.push(offset);
    if (!text.trim()) boundaries.push(offset + line.length + 1);
    if (!text.trim() || depth !== previousDepth) table = false;
    const nextLine = quotedLine(lines[index + 1] ?? "");
    const startsTable =
      text.includes("|") && nextLine.depth === depth && TABLE_DELIMITER.test(nextLine.text);
    table = startsTable || (table && text.includes("|"));
    if (table) {
      boundaries.push(offset);
      for (let column = 0; column < text.length; column++) {
        if (text[column] !== "|") continue;
        let slashes = 0;
        for (let at = column - 1; at >= 0 && text[at] === "\\"; at--) slashes++;
        if (!(slashes % 2)) boundaries.push(offset + line.length - text.length + column);
      }
      boundaries.push(offset + line.length + 1);
    }
    previousDepth = depth;
    offset += line.length + 1;
  }
  const runs = [...source.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const closing = new Map<number, number>();
  let boundary = boundaries.length - 1;
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    while (boundary >= 0 && run.index < boundaries[boundary]!) {
      next.clear();
      boundary--;
    }
    const end = next.get(run[0].length);
    if (end !== undefined) closing.set(run.index, end);
    next.set(run[0].length, run.index);
  }
  const tags = [
    ...source.matchAll(
      /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|<!--[\s\S]*?(?:-->|$)/gi,
    ),
  ];
  const ranges: CodeRange[] = [];
  let endOffset = 0;
  let tagIndex = 0;
  let htmlCode: string | undefined;
  for (const run of runs) {
    if (run.index < endOffset) continue;
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= run.index) {
      const tag = /^<(\/?)(pre|code)(?=[\s>])/i.exec(tags[tagIndex]![0]);
      if (tag) {
        const name = tag[2]!.toLowerCase();
        if (!htmlCode && !tag[1]) htmlCode = name;
        else if (htmlCode === name && tag[1]) htmlCode = undefined;
      }
      tagIndex++;
    }
    if (htmlCode || (tags[tagIndex] && tags[tagIndex]!.index <= run.index)) continue;
    let slashes = 0;
    for (let index = run.index - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
    const closingStart = closing.get(run.index);
    if (slashes % 2 || closingStart === undefined) continue;
    endOffset = closingStart + run[0].length;
    ranges.push({ start: run.index, end: endOffset, delimiterLength: run[0].length });
    while (tags[tagIndex] && tags[tagIndex]!.index < endOffset) tagIndex++;
  }
  return ranges;
}

export function replaceCodeRanges(
  text: string,
  ranges: readonly CodeRange[],
  replace: (value: string) => string,
): string {
  const parts: string[] = [];
  let offset = 0;
  for (const range of ranges) {
    parts.push(text.slice(offset, range.start), replace(text.slice(range.start, range.end)));
    offset = range.end;
  }
  parts.push(text.slice(offset));
  return joinMarkdown(parts);
}

export function markdownCodeBlocks(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let fenced: { start: number; marker: string; quotes: number; column: number } | undefined;
  let indented: { start: number; quotes: number } | undefined;
  let previousBlank = true;
  let previousDepth = 0;
  let listColumn = 0;
  let htmlCode: string | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const quote = quotedLine(line);
    if (fenced) {
      const content = quotedLine(line, fenced.quotes);
      const indent = /^ */.exec(content.text)![0].length;
      if (content.depth < fenced.quotes || (content.text.trim() && indent < fenced.column)) {
        ranges.push({ start: fenced.start, end: Math.max(fenced.start, offset - 1) });
        fenced = undefined;
      } else {
        const marker = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(content.text.slice(fenced.column));
        if (
          marker?.[1] &&
          marker[1][0] === fenced.marker[0] &&
          marker[1].length >= fenced.marker.length
        ) {
          ranges.push({ start: fenced.start, end: offset + line.length });
          fenced = undefined;
        }
        offset += line.length + 1;
        continue;
      }
    }
    if (quote.depth !== previousDepth) {
      listColumn = 0;
      previousBlank = true;
    }
    previousDepth = quote.depth;
    const indentation = /^ */.exec(quote.text)![0].length;
    const blank = !quote.text.trim();
    if (
      indented &&
      (quote.depth !== indented.quotes ||
        (!blank && indentation < listColumn + 4 && !quote.text.startsWith("\t")))
    ) {
      ranges.push({ start: indented.start, end: Math.max(indented.start, offset - 1) });
      indented = undefined;
    }
    if (indented) {
      offset += line.length + 1;
      continue;
    }
    const item = /^ *(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(quote.text);
    if (item) listColumn = item[0].length;
    else if (!blank && indentation < listColumn) listColumn = 0;
    const content = item
      ? quote.text.slice(listColumn)
      : quote.text.slice(Math.min(indentation, listColumn));
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (!htmlCode && marker?.[1] && (marker[1][0] !== "`" || !marker[2]?.includes("`"))) {
      fenced = { start: offset, marker: marker[1], quotes: quote.depth, column: listColumn };
    } else if (
      !htmlCode &&
      previousBlank &&
      (quote.text.startsWith("\t") || indentation >= listColumn + 4)
    ) {
      indented = { start: offset, quotes: quote.depth };
    } else {
      const masked = replaceCodeRanges(line, inlineCodeRanges(line), (value) =>
        " ".repeat(value.length),
      );
      for (const token of masked.matchAll(
        /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi,
      )) {
        const tag = /^<(\/?)(pre|code)(?=[\s>])/i.exec(token[0]);
        if (!tag) continue;
        const name = tag[2]!.toLowerCase();
        if (!htmlCode && !tag[1]) htmlCode = name;
        else if (htmlCode === name && tag[1]) htmlCode = undefined;
      }
    }
    previousBlank = blank;
    offset += line.length + 1;
  }
  if (fenced || indented) ranges.push({ start: (fenced ?? indented)!.start, end: text.length });
  return ranges;
}
