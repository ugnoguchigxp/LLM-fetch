import { domNodeAttributes, domNodeChildren, domNodeName } from "./html-limits.js";
import { LlmFetchError } from "../errors.js";
import { joinMarkdown } from "./markdown-output.js";

interface Cell {
  text: string;
  start: number;
  end: number;
  lastRow: number;
  header: boolean;
}

function span(value: string | undefined, maximum: number, zero = 1): number {
  if (value === "0") return zero;
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Math.min(maximum, Number(value)));
}

export function renderMarkdownTable(node: unknown, render: (node: unknown) => string): string {
  const rows: { node: unknown; group: unknown }[] = [];
  const captions: string[] = [];
  const stack = [...domNodeChildren(node)].reverse().map((child) => ({ node: child, group: node }));
  while (stack.length) {
    const entry = stack.pop()!;
    const child = entry.node;
    const name = domNodeName(child);
    if (name === "table") continue;
    if (name === "caption") captions.push(render(child).trim());
    else if (name === "tr") rows.push(entry);
    else
      stack.push(
        ...[...domNodeChildren(child)].reverse().map((node) => ({
          node,
          group: ["thead", "tbody", "tfoot"].includes(name) ? child : entry.group,
        })),
      );
  }
  const groupEnds = new Map<unknown, number>();
  for (const [index, row] of rows.entries()) groupEnds.set(row.group, index + 1);
  const rendered: Cell[][] = [];
  let active: Cell[] = [];
  let simple = true;
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    active = active.filter((cell) => cell.lastRow >= rowNumber);
    let column = 1;
    const cells: Cell[] = [];
    for (const child of domNodeChildren(row.node)) {
      const name = domNodeName(child);
      if (name !== "th" && name !== "td") continue;
      const attributes = domNodeAttributes(child);
      const width = span(attributes.colspan, 1_000);
      const remainingRows = groupEnds.get(row.group)! - index;
      const height = Math.min(remainingRows, span(attributes.rowspan, 65_534, remainingRows));
      while (true) {
        const collision = active.find(
          (cell) => cell.start <= column + width - 1 && cell.end >= column,
        );
        if (!collision) break;
        column = collision.end + 1;
      }
      if (column + width - 1 > 1_024) {
        throw new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          "The table exceeded the conversion column limit.",
        );
      }
      const text = render(child).trim();
      const cell: Cell = {
        text,
        start: column,
        end: column + width - 1,
        lastRow: rowNumber + height - 1,
        header: name === "th",
      };
      cells.push(cell);
      if (height > 1) active.push(cell);
      column += width;
      const descendants = [...domNodeChildren(child)];
      let complexContent = false;
      while (descendants.length) {
        const descendant = descendants.pop();
        if (["table", "pre", "ul", "ol", "blockquote"].includes(domNodeName(descendant))) {
          complexContent = true;
          break;
        }
        descendants.push(...domNodeChildren(descendant));
      }
      if (width !== 1 || height !== 1 || complexContent || /\n\s*\n/.test(text)) simple = false;
    }
    rendered.push(cells);
  }
  const first = rendered[0];
  const width = first?.length ?? 0;
  simple &&= width > 0 && rendered.every((row) => row.length === width);
  const caption = captions.filter(Boolean).join("\n\n");
  if (!rendered.some((row) => row.length)) return caption;
  if (simple) {
    const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const lines = rendered.map((row) => `|${row.map((item) => cell(item.text)).join("|")}|`);
    if (first?.every((item) => item.header))
      lines.splice(1, 0, `|${Array(width).fill("---").join("|")}|`);
    else
      lines.unshift(
        `|${Array.from({ length: width }, (_, index) => `Column ${index + 1}`).join("|")}|`,
        `|${Array(width).fill("---").join("|")}|`,
      );
    return joinMarkdown([caption, joinMarkdown(lines, "\n")].filter(Boolean), "\n\n");
  }
  // Emit each source cell once. Expanding a rowspan can multiply both text and tokens.
  const records = rendered.map((row, index) => {
    const cells = row.map((cell) => {
      const column = cell.start === cell.end ? `${cell.start}` : `${cell.start}–${cell.end}`;
      const rowRange = cell.lastRow > index + 1 ? `; rows ${index + 1}–${cell.lastRow}` : "";
      const label = `  - Column ${column}${rowRange}${cell.header ? "; header" : ""}:`;
      return cell.text.includes("\n")
        ? `${label}\n\n    ${cell.text.replace(/\n/g, "\n    ")}`
        : `${label} ${cell.text}`;
    });
    return joinMarkdown([`- Row ${index + 1}`, ...cells], "\n");
  });
  return joinMarkdown([caption, joinMarkdown(records, "\n")].filter(Boolean), "\n\n");
}
