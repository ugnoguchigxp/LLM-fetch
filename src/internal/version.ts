declare const __LLM_FETCH_VERSION__: string;

export const PACKAGE_VERSION =
  typeof __LLM_FETCH_VERSION__ === "string"
    ? __LLM_FETCH_VERSION__
    : "0.1.0-development";
