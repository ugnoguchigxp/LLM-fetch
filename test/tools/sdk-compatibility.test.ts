import type { Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Tool as ResponsesTool } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import { createLlmFetch } from "../../src/index.js";

describe("SDK tool definition compatibility", () => {
  it("assigns definitions to OpenAI Responses, Chat Completions, and Bedrock SDK types", () => {
    const toolset = createLlmFetch({
      search: { name: "fixture", async search() { return []; } },
      fetcher: vi.fn(),
    }).toolset();

    const responses: ResponsesTool[] = toolset.openaiResponsesDefinitions();
    const chat: ChatCompletionTool[] =
      toolset.openaiChatCompletionsDefinitions();
    const bedrock: BedrockTool[] = toolset.bedrockDefinitions();

    expect(responses).toHaveLength(2);
    expect(chat).toHaveLength(2);
    expect(bedrock).toHaveLength(2);
  });
});
