import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmQuotaError } from "./errors.js";
import {
  createOllamaMessageCreator,
  FallbackMessageCreator,
  type MessageCreator,
  type MessageRequest,
  type RawCompletion,
} from "./llmClient.js";
import { nullLogger } from "./logger.js";
import type { TokenUsage } from "./types.js";

const usage: TokenUsage = { inputTokens: 1, outputTokens: 1 };

function baseRequest(overrides: Partial<MessageRequest> = {}): MessageRequest {
  return {
    model: "claude-haiku-4-5",
    maxTokens: 100,
    system: "system prompt",
    user: "user prompt",
    ...overrides,
  };
}

/**
 * Regression guard for the cloud→local fallback bug: Ollama and Anthropic have
 * disjoint model namespaces, so if the Ollama creator sent `req.model`
 * (a `claude-*` id inherited from the cloud request), Ollama would 404 on
 * every fallback attempt. The creator must send the model it was configured
 * with, never the one carried on the request.
 */
describe("createOllamaMessageCreator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the configured Ollama model in create(), not req.model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }), {
          status: 200,
        });
      })
    );

    const creator = createOllamaMessageCreator("http://ollama:11434", nullLogger, "mistral-nemo:latest");
    await creator.create(baseRequest({ model: "claude-haiku-4-5" }));

    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("mistral-nemo:latest");
  });

  it("sends the configured Ollama model in createStream(), not req.model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 200 });
      })
    );

    const creator = createOllamaMessageCreator("http://ollama:11434", nullLogger, "mistral-nemo:latest");
    const stream = creator.createStream(baseRequest({ model: "claude-sonnet-5" }));
    for await (const _chunk of stream) {
      // drain
    }

    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("mistral-nemo:latest");
  });

  it("constructs a usable creator for the no-providers-configured default path", () => {
    // Mirrors modules/curator/index.ts's `creators.length === 0` fallback,
    // which must still type-check and produce a working MessageCreator now
    // that `model` is a required parameter.
    const creator = createOllamaMessageCreator("http://ollama:11434", nullLogger, "mistral-nemo:latest");
    expect(typeof creator.create).toBe("function");
    expect(typeof creator.createStream).toBe("function");
  });
});

/**
 * Regression guard for the fallback bug's other half: even once each creator
 * resolves its own model, FallbackMessageCreator must still fall through on a
 * quota failure rather than treating it as terminal.
 */
describe("FallbackMessageCreator", () => {
  function stubCreator(behavior: () => Promise<RawCompletion>): MessageCreator {
    return {
      create: vi.fn(behavior),
      async *createStream() {
        const res = await behavior();
        yield res.text;
      },
    };
  }

  it("falls through a quota error from the first creator to the second", async () => {
    const failing = stubCreator(async () => {
      throw new LlmQuotaError("Anthropic quota/credit issue: out of credit");
    });
    const succeeding = stubCreator(async () => ({ text: "local result", usage }));

    const fallback = new FallbackMessageCreator([failing, succeeding], nullLogger);
    const result = await fallback.create(baseRequest());

    expect(result.text).toBe("local result");
    expect(failing.create).toHaveBeenCalledTimes(1);
    expect(succeeding.create).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when every creator fails", async () => {
    const quotaError = new LlmQuotaError("out of credit");
    const failing = stubCreator(async () => {
      throw quotaError;
    });

    const fallback = new FallbackMessageCreator([failing], nullLogger);

    await expect(fallback.create(baseRequest())).rejects.toBe(quotaError);
  });
});
