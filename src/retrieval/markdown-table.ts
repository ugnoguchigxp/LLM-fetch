import { domNodeAttributes, domNodeChildren, domNodeData, domNodeName } from "./html-limits.js";
import { LlmFetchError } from "../errors.js";
import { joinMarkdown, MAX_MARKDOWN_CHARACTERS } from "./markdown-output.js";

interface Cell {
  text: string;
  start: number;
  end: number;
  lastRow: number;
  header: boolean;
  iconOnly: boolean;
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
        iconOnly: false,
      };
      cells.push(cell);
      if (height > 1) active.push(cell);
      column += width;
      const descendants = [...domNodeChildren(child)];
      let complexContent = false;
      let hasImage = false;
      let hasText = false;
      while (descendants.length) {
        const descendant = descendants.pop();
        hasImage ||= domNodeName(descendant) === "img";
        hasText ||= !!domNodeData(descendant).trim();
        if (["table", "pre", "ul", "ol", "blockquote"].includes(domNodeName(descendant))) {
          complexContent = true;
          break;
        }
        descendants.push(...domNodeChildren(descendant));
      }
      cell.iconOnly = hasImage && !hasText;
      if (complexContent) simple = false;
    }
    rendered.push(cells);
  }
  const width = rendered.reduce(
    (maximum, row) => row.reduce((maximum, cell) => Math.max(maximum, cell.end), maximum),
    0,
  );
  simple &&= width > 0;
  const caption = captions.filter(Boolean).join("\n\n");
  if (!rendered.some((row) => row.length)) return caption;
  if (simple) {
    // Bound expansion before allocating a grid: a small HTML span can otherwise
    // produce millions of repeated cells. Output text retains its own cap too.
    if (width * rendered.length > MAX_MARKDOWN_CHARACTERS / 2)
      throw new LlmFetchError("RESPONSE_TOO_LARGE", "The table exceeded the expansion limit.");
    const grid: (Cell | undefined)[][] = Array.from({ length: rendered.length }, () =>
      Array<Cell | undefined>(width),
    );
    for (const [index, row] of rendered.entries())
      for (const item of row)
        for (let rowIndex = index; rowIndex < item.lastRow; rowIndex++) {
          for (let column = item.start - 1; column < item.end; column++)
            grid[rowIndex]![column] = item;
        }

    const metadata: string[] = [];
    const compact: (Cell | undefined)[][] = [];
    for (const row of grid) {
      const label = row[0];
      const value = row[1];
      if (
        width > 12 &&
        label?.header &&
        !value?.header &&
        value?.start === 2 &&
        value.end === width
      ) {
        if (value.text) metadata.push(`${label.text}: ${value.text}`);
        continue;
      }
      compact.push(row);
    }
    let values: string[][] = [];
    let hasHeader = false;
    if (
      width > 12 &&
      compact.length > 0 &&
      !compact[0]?.every((item) => item?.header) &&
      compact.every((row) => row[0]?.header)
    ) {
      // Row headers make a wide matrix safely transposable. A rowspan label
      // groups consecutive subrows (e.g. direction and speed) in each cell.
      const groups: (Cell | undefined)[][][] = [];
      for (const row of compact) {
        const previous = groups.at(-1);
        if (previous && previous[0]?.[0] === row[0]) previous.push(row);
        else groups.push([row]);
      }
      const headers = groups.map((group) => group[0]?.[0]?.text ?? "");
      values = [headers];
      for (let column = 1; column < width; column++)
        values.push(
          groups.map((group) => {
            const seen = new Set<Cell>();
            const items = group.map((row) => row[column]);
            const displayed = new Set(
              items.filter((item) => item && !item.iconOnly).map((item) => item!.text),
            );
            return joinMarkdown(
              items
                .filter((item): item is Cell => {
                  if (!item?.text || seen.has(item) || (item.iconOnly && displayed.has(item.text)))
                    return false;
                  seen.add(item);
                  return true;
                })
                .map((item) => item.text),
              " / ",
            );
          }),
        );
      hasHeader = true;
    } else {
      values = compact.map((row) =>
        Array.from({ length: width }, (_, index) => row[index]?.text ?? ""),
      );
      hasHeader = compact[0]?.some((item) => item?.header) ?? false;
    }
    if (!values.length) return joinMarkdown([caption, ...metadata].filter(Boolean), "\n\n");
    const expandedCharacters = values.reduce(
      (total, row) => total + row.reduce((total, text) => total + text.length + 1, 0),
      0,
    );
    if (expandedCharacters > MAX_MARKDOWN_CHARACTERS)
      throw new LlmFetchError("RESPONSE_TOO_LARGE", "The table exceeded the expansion limit.");
    const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
    const columnCount = values[0]!.length;
    const tables: string[] = [];
    // Keep the first column as the row identifier in every horizontal slice.
    for (let start = 1; start < columnCount || start === 1; start += 11) {
      const end = Math.min(columnCount, start + 11);
      const slice = (row: string[]): string[] => [row[0] ?? "", ...row.slice(start, end)];
      const sliced = values.map(slice);
      const sliceWidth = sliced[0]!.length;
      const lines = sliced.map((row) => `|${joinMarkdown(row.map(cell), "|")}|`);
      const separator = `|${Array(sliceWidth).fill("---").join("|")}|`;
      if (hasHeader) lines.splice(1, 0, separator);
      else
        lines.unshift(
          `|${[0, ...Array.from({ length: end - start }, (_, index) => start + index)]
            .map((column) => `Column ${column + 1}`)
            .join("|")}|`,
          separator,
        );
      tables.push(joinMarkdown(lines, "\n"));
    }
    return joinMarkdown([caption, ...metadata, ...tables].filter(Boolean), "\n\n");
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
