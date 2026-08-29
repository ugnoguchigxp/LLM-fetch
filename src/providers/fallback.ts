import type { SearchHit, SearchInput, SearchProvider } from "../contracts.js";
import { LlmFetchError } from "../errors.js";

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function fallbackSearch(providers: readonly SearchProvider[]): SearchProvider {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new LlmFetchError(
      "CONFIG_MISSING",
      "fallbackSearch requires at least one provider.",
    );
  }
  if (providers.length > 10) {
    throw new LlmFetchError("INVALID_INPUT", "fallbackSearch supports at most 10 providers.");
  }
  const chain = [...providers];
  if (
    chain.some(
      (provider) =>
        !provider ||
        typeof provider.name !== "string" ||
        !provider.name.trim() ||
        provider.name.length > 100 ||
        hasControlCharacters(provider.name) ||
        typeof provider.search !== "function",
    )
  ) {
    throw new LlmFetchError("INVALID_INPUT", "fallbackSearch received an invalid provider.");
  }
  const name = chain.map((provider) => provider.name.trim()).join("->");
  if (name.length > 500) {
    throw new LlmFetchError("INVALID_INPUT", "fallbackSearch provider names are too long.");
  }

  return {
    name,
    async search(input: SearchInput): Promise<SearchHit[]> {
      let lastError: LlmFetchError | undefined;
      for (const provider of chain) {
        try {
          return await provider.search(input);
        } catch (error) {
          if (!(error instanceof LlmFetchError) || !error.retryable) throw error;
          lastError = error;
        }
      }
      throw (
        lastError ??
        new LlmFetchError("UNKNOWN", "All search providers failed.", {
          retryable: true,
        })
      );
    },
  };
}
