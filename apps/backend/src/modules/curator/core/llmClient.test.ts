import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmQuotaError } from "./errors.js";
import {
  createOllamaMessageCreator,
  FallbackMessageCreator,
  LlmClient,
  type MessageCreator,
  type MessageRequest,
  type RawCompletion,
} from "./llmClient.js";
import { nullLogger } from "./logger.js";
import type { Book, TokenUsage } from "./types.js";

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

  /**
   * Regression guard for the silent-truncation bug. Ollama draws `num_predict`
   * from the same window as the prompt and truncates the overflow without
   * complaint, keeping the TAIL. With no `num_ctx` sent, a whole-library
   * recommendation prompt reached the model as its alphabetically-last dozen
   * books and none of the user's actual request — and still answered
   * confidently. These tests assert the option is present and correctly sized;
   * dropping `num_ctx` from either request body fails them.
   */
  it("sends a num_ctx sized to hold the prompt and the reserved completion", async () => {
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

    // ~2000 tokens of prompt at the 4-chars-per-token estimate, plus a 4096
    // completion reservation: comfortably past Ollama's 4096 default, which is
    // exactly the case that used to truncate.
    const creator = createOllamaMessageCreator("http://ollama:11434", nullLogger, "mistral-nemo:latest");
    await creator.create(baseRequest({ maxTokens: 4096, user: "x".repeat(8000) }));

    const options = bodies[0].options as Record<string, number>;
    expect(options.num_ctx).toBeGreaterThan(options.num_predict);
    expect(options.num_ctx).toBeGreaterThanOrEqual(2000 + 4096);
  });

  it("sends num_ctx on the streaming path too", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 200 });
      })
    );

    const creator = createOllamaMessageCreator("http://ollama:11434", nullLogger, "mistral-nemo:latest");
    const stream = creator.createStream(baseRequest({ maxTokens: 4096, user: "x".repeat(8000) }));
    for await (const _chunk of stream) {
      // drain
    }

    const options = bodies[0].options as Record<string, number>;
    expect(options.num_ctx).toBeGreaterThanOrEqual(2000 + 4096);
  });

  it("never asks for less than Ollama's own default window", async () => {
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
    await creator.create(baseRequest({ maxTokens: 100, system: "s", user: "u" }));

    expect((bodies[0].options as Record<string, number>).num_ctx).toBe(4096);
  });

  it("clamps to the ceiling and warns rather than truncating silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }), {
          status: 200,
        })
      )
    );
    const warn = vi.fn();
    const logger = { ...nullLogger, warn };

    const creator = createOllamaMessageCreator("http://ollama:11434", logger, "mistral-nemo:latest", 8192);
    await creator.create(baseRequest({ maxTokens: 4096, user: "x".repeat(200_000) }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/truncated/i);
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

/**
 * R2 wiring: the tagging prompt's `Description:` line must come from
 * `resolveDescription`, not `book.description` directly, so a book R2
 * backfilled actually reaches the LLM as having a description.
 */
describe("LlmClient#tagBook description resolution", () => {
  function makeBook(overrides: Partial<Book> = {}): Book {
    return {
      id: "book-1",
      title: "Test Book",
      author: "Test Author",
      series: null,
      seriesSequence: null,
      durationSeconds: 3600,
      publishedYear: 2020,
      genres: [],
      description: null,
      coverPath: null,
      absAddedAt: null,
      lastSyncedAt: Date.now(),
      ...overrides,
    };
  }

  async function tagAndCapture(book: Book): Promise<string> {
    const requests: MessageRequest[] = [];
    const llm = new LlmClient({
      taggingModel: "tag-test",
      collectionModel: "collection-test",
      rateLimiter: { acquire: async () => undefined },
      creator: {
        async create(request) {
          requests.push(request);
          return { text: JSON.stringify({ tags: [] }), usage };
        },
        createStream() {
          throw new Error("not used");
        },
      },
    });

    await llm.tagBook(book);
    return requests[0]?.user ?? "";
  }

  it("uses the harvested description when ABS has none", async () => {
    const book = makeBook({
      description: null,
      descriptionEnriched: "A harvested synopsis naming Detective Anna Pigeon.",
      descriptionSource: "audnexus",
    });

    const prompt = await tagAndCapture(book);

    expect(prompt).toContain("Description: A harvested synopsis naming Detective Anna Pigeon.");
    expect(prompt).not.toContain("Description: none");
  });

  it("prefers a short ABS description over a long harvested one", async () => {
    const book = makeBook({
      description: "A Key West caper. Nothing goes to plan.",
      descriptionEnriched: "H".repeat(2000),
      descriptionSource: "googlebooks",
    });

    const prompt = await tagAndCapture(book);

    expect(prompt).toContain("Description: A Key West caper. Nothing goes to plan.");
  });

  it('falls back to "none" when neither ABS nor a harvested description is present', async () => {
    const book = makeBook({ description: null, descriptionEnriched: null, descriptionSource: null });

    const prompt = await tagAndCapture(book);

    expect(prompt).toContain("Description: none");
  });
});
