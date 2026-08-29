import type { SearchProvider } from "../contracts.js";
import { LlmFetchError } from "../errors.js";

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function custom(provider: SearchProvider): SearchProvider {
  if (
    !provider ||
    typeof provider.name !== "string" ||
    !provider.name.trim() ||
    provider.name.length > 100 ||
    hasControlCharacters(provider.name) ||
    typeof provider.search !== "function"
  ) {
    throw new LlmFetchError("INVALID_INPUT", "Invalid custom search provider.");
  }
  return provider;
}
