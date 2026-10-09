import { domNodeAttributes, domNodeChildren, domNodeName } from "./html-limits.js";

// Only this bounded class-derived value can enter a generated code fence.
// Inspection and output must select exactly the same value.
export function codeLanguage(node: unknown): string {
  const code = domNodeChildren(node).find((child) => domNodeName(child) === "code");
  return (
    /(?:^|\s)language-([\w+-]{1,32})(?:\s|$)/.exec(
      domNodeAttributes(code ?? node).class ?? "",
    )?.[1] ?? ""
  );
}
