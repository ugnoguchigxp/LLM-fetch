import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { z } from "zod";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Measurement, Model, ModelStage, Usage } from "./contracts.ts";

export function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown error";
  // Never log credentials from upstream stderr. Results are local and ignored.
  for (const [key, value] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value && value.length > 5) {
      message = message.replaceAll(value, "[redacted]");
    }
  }
  return message.slice(0, 1500);
}

export type StreamSource = {
  startThread(options: ThreadOptions): {
    readonly id?: string | null;
    runStreamed(
      prompt: string,
      options: TurnOptions,
    ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
  };
};

// Structured Outputs accepts only its documented subset of JSON Schema string
// formats. Zod's URL emits `format: uri`, which the Responses endpoint rejects.
// Keep full URL validation in schema.parse after generation.
export function outputSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    override: ({ jsonSchema }) => {
      if (jsonSchema.format === "uri") delete jsonSchema.format;
    },
  });
}

export function sdkEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (allowed.has(entry[0]) || entry[0].startsWith("LC_")),
    ),
  );
}
export function sdkModel(
  codex: StreamSource,
  cwd: string,
  model: string,
  judgeModel: string,
  timeoutMs: number,
): Model {
  let researchThread: ReturnType<StreamSource["startThread"]> | null = null;
  return {
    async generate<T>(
      stage: ModelStage,
      prompt: string,
      schema: z.ZodType<T>,
      signal: AbortSignal,
      measurements: Measurement[],
    ): Promise<T> {
      const selectedModel = stage === "judge" ? judgeModel : model;
      const started = performance.now();
      const measurement: Measurement = {
        stage,
        model: selectedModel,
        durationMs: 0,
        firstEventMs: null,
        firstMessageEventMs: null,
        usage: null,
        threadId: null,
        error: null,
        sdkEvents: [],
        sdkDiagnostics: [],
      };
      measurements.push(measurement);
      let response = "";
      let completed = false;
      let failure: string | null = null;
      const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        callSignal.throwIfAborted();
        const options: ThreadOptions = {
          model: selectedModel,
          modelReasoningEffort: "low",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          webSearchMode: "disabled",
          networkAccessEnabled: false,
          skipGitRepoCheck: true,
          workingDirectory: cwd,
        };
        const isolated = stage === "judge" || stage === "guard" || stage === "assess";
        if (stage === "query") researchThread = codex.startThread(options);
        const thread = isolated
          ? codex.startThread(options)
          : (researchThread ?? codex.startThread(options));
        if (!isolated) researchThread = thread;
        measurement.threadId = thread.id ?? null;
        const { events } = await thread.runStreamed(prompt, {
          outputSchema: outputSchema(schema),
          signal: callSignal,
        });
        for await (const event of events) {
          if (measurement.sdkEvents!.length < 32) measurement.sdkEvents!.push(event.type);
          measurement.firstEventMs ??= performance.now() - started;
          if (event.type === "thread.started") measurement.threadId = event.thread_id;
          if (event.type === "turn.failed") failure = event.error.message;
          if (
            (event.type === "error" || event.type === "turn.failed") &&
            measurement.sdkDiagnostics!.length < 8
          ) {
            measurement.sdkDiagnostics!.push(
              errorMessage(new Error(event.type === "error" ? event.message : event.error.message)),
            );
          }
          if (event.type === "turn.completed") {
            completed = true;
            const u = event.usage;
            measurement.usage = {
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              cacheWriteInputTokens: u.cache_write_input_tokens ?? null,
              outputTokens: u.output_tokens,
              reasoningOutputTokens: u.reasoning_output_tokens ?? null,
            } satisfies Usage;
          }
          if (event.type.startsWith("item.") && "item" in event) {
            const item = event.item;
            if (item.type === "agent_message") {
              measurement.firstMessageEventMs ??= performance.now() - started;
              if (event.type === "item.completed") response = item.text;
            } else if (item.type === "error") {
              if (measurement.sdkDiagnostics!.length < 8)
                measurement.sdkDiagnostics!.push(errorMessage(new Error(item.message)));
            } else if (item.type !== "reasoning") {
              // A contaminated run must never receive a passing score.
              failure = `Unexpected SDK tool/item: ${item.type}`;
            }
          }
        }
        if (failure) throw new Error(failure);
        if (!completed) throw new Error("SDK stream ended without turn.completed");
        const parsed = schema.parse(JSON.parse(response));
        if (
          stage === "guard" &&
          parsed &&
          typeof parsed === "object" &&
          "decision" in parsed &&
          typeof parsed.decision === "string"
        )
          measurement.guardDecision = parsed.decision;
        return parsed;
      } catch (error) {
        // Preserve a streamed diagnostic if the SDK subsequently throws a
        // generic process-exit error while draining its event generator.
        const diagnostic = failure ?? measurement.sdkDiagnostics!.at(-1);
        const detailed = callSignal.aborted
          ? callSignal.reason
          : diagnostic
            ? new Error(diagnostic, { cause: error })
            : error;
        measurement.error = errorMessage(detailed);
        throw detailed;
      } finally {
        measurement.durationMs = performance.now() - started;
      }
    },
  };
}

export async function createModel(
  model: string,
  judgeModel: string,
  timeoutMs: number,
  serviceTier: "standard" | "fast" = "standard",
) {
  const root = await mkdtemp(join(tmpdir(), "llm-fetch-eval-"));
  const home = join(root, "codex-home");
  const cwd = join(root, "workspace");
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  try {
    // Reuse login only. Do not inherit MCP servers, plugins, project instructions,
    // model defaults, or tools that could bypass the llm-fetch retrieval under test.
    try {
      await copyFile(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
        join(home, "auth.json"),
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
      // API-key authentication and keyring-backed installations may have no file.
    }
    const env = sdkEnvironment(process.env);
    const codex = new Codex({
      ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
      env: { ...env, CODEX_HOME: home },
      config: {
        model_instructions_file: fileURLToPath(new URL("model-instructions.txt", import.meta.url)),
        project_doc_max_bytes: 0,
        suppress_unstable_features_warning: true,
        model_provider: "evaluation",
        model_providers: {
          evaluation: {
            name: "OpenAI evaluation",
            wire_api: "responses",
            requires_openai_auth: true,
            supports_websockets: false,
          },
        },
        ...(serviceTier === "fast" ? { service_tier: "fast" } : {}),
        features: {
          shell_tool: false,
          apps: false,
          plugins: false,
          image_generation: false,
          multi_agent: false,
          multi_agent_v2: false,
          unified_exec: false,
          view_image: false,
          sleep_tool: false,
          goals: false,
          workspace_dependencies: false,
          worktrees: false,
          skill_search: false,
          skip_host_skill_discovery: true,
          computer_use: false,
          browser_use: false,
          browser_use_external: false,
          in_app_browser: false,
          fast_mode: true,
        },
      },
    });
    return {
      model: sdkModel(codex, cwd, model, judgeModel, timeoutMs),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
