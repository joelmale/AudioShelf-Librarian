/**
 * Anthropic SDK wrapper.
 *
 * Cost control: tagging uses the cheaper TAGGING_MODEL (Haiku by default);
 * collection reasoning uses COLLECTION_MODEL (Sonnet). Calls are kept
 * model-agnostic (plain messages.create, no thinking/effort params — Haiku 4.5
 * rejects `effort`), with JSON instructed via the prompt and validated with Zod.
 *
 * Adversarial set (MADP-FULL): A1 (429 → bounded exponential backoff + jitter,
 * then a typed error if exhausted), A2 (quota/billing → typed LlmQuotaError,
 * NOT retried), A3 (prose-wrapped / invalid JSON → graceful Zod failure + the
 * offending text logged), D1–D3 (every path typed, nothing swallowed). The SDK's
 * own retry is disabled (maxRetries: 0) so the backoff logic here is the single
 * source of truth and is testable. The low-level call is injectable via
 * `MessageCreator` so the failure modes can be simulated without the network.
 */
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmInvalidResponseError,
  LlmQuotaError,
  LlmRateLimitError,
  LlmRequestError,
  AppError,
} from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import type { NowFn, SleepFn } from './rateLimiter.js';
import {
  collectionProposalSchema,
  multiCollectionProposalSchema,
  tagResponseSchema,
  type Book,
  type BookTagResult,
  type CollectionProposal,
  type TagSummary,
  type TokenUsage,
} from './types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { 
  AnthropicErrorTranslator, 
  OllamaErrorTranslator 
} from './errorTranslators.js';

/** Minimal rate-limiter surface (decouples LlmClient from the concrete class). */
export interface RateLimiterLike {
  acquire(estimatedTokens: number): Promise<void>;
}

export interface MessageRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  responseSchema?: z.ZodTypeAny;
}

export interface RawCompletion {
  text: string;
  usage: TokenUsage;
}

/** The single low-level operation; injectable so tests can simulate failures. */
export interface MessageCreator {
  create(req: MessageRequest): Promise<RawCompletion>;
  createStream(req: MessageRequest): AsyncIterableIterator<string>;
}

export interface LlmClientOptions {
  taggingModel: string;
  collectionModel: string;
  rateLimiter: RateLimiterLike;
  creator: MessageCreator;
  logger?: Logger;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: SleepFn;
  now?: NowFn;
  random?: () => number;
}


const llmClientOptionsSchema = z.object({
  taggingModel: z.string().min(1),
  collectionModel: z.string().min(1),
  maxRetries: z.number().int().min(0).optional(),
  baseDelayMs: z.number().int().positive().optional(),
  maxDelayMs: z.number().int().positive().optional(),
  rateLimiter: z.custom<RateLimiterLike>(),
  creator: z.custom<MessageCreator>(),
  logger: z.custom<Logger>().optional(),
  sleep: z.custom<SleepFn>().optional(),
  random: z.custom<() => number>().optional(),
  now: z.custom<NowFn>().optional(),
});

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 30_000;

interface Classified {
  error: AppError;
  retryable: boolean;
  retryAfterMs?: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Read a possibly-present numeric field off an unknown error shape. */
function isHttpError(err: unknown): err is { status: number } {
  return typeof err === 'object' && err !== null && 'status' in err && typeof (err as Record<string, unknown>).status === 'number';
}
function readStatus(err: unknown): number | undefined {
  if (isHttpError(err)) return err.status;
  return undefined;
}

function isErrorWithType(err: unknown): err is { type: string } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof (err as Record<string, unknown>).type === 'string';
}
function isErrorWithNestedType(err: unknown): err is { error: { type: string } } {
  return typeof err === 'object' && err !== null && 'error' in err && 
         typeof (err as Record<string, unknown>).error === 'object' && 
         (err as Record<string, unknown>).error !== null && 
         'type' in ((err as Record<string, unknown>).error as Record<string, unknown>) && 
         typeof (((err as Record<string, unknown>).error as Record<string, unknown>).type) === 'string';
}
function readErrorType(err: unknown): string | undefined {
  if (isErrorWithType(err)) return err.type;
  if (isErrorWithNestedType(err)) return err.error.type;
  return undefined;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Anthropic request failed';
}

/**
 * Robustly extract a JSON object/array from model text that may be wrapped in
 * prose or ```code fences``` (adversarial A3), then validate with Zod.
 */
export function parseJsonResponse<T, U = unknown>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, U>,
  logger: Logger,
  context: string
): T {
  const candidate = extractJson(text);
  if (candidate === null) {
    logger.error('No JSON found in model response', { context, preview: text.slice(0, 500) });
    throw new LlmInvalidResponseError(`No JSON found in model response (${context})`, {
      preview: text.slice(0, 500),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    logger.error('Model response was not valid JSON', {
      context,
      preview: candidate.slice(0, 500),
      cause: err instanceof Error ? err.message : String(err),
    });
    throw new LlmInvalidResponseError(`Model returned invalid JSON (${context})`, {
      preview: candidate.slice(0, 500),
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    logger.error('Model JSON failed schema validation', {
      context,
      issues: result.error.issues,
      preview: candidate.slice(0, 500),
    });
    throw new LlmInvalidResponseError(`Model JSON did not match schema (${context})`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  // Strip a ```json ... ``` (or bare ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1] ? fence[1].trim() : trimmed;
  // Find the first { or [ and the matching last } or ].
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  return body.slice(start, end + 1);
}

export class LlmClient {
  private readonly taggingModel: string;
  private readonly collectionModel: string;
  private readonly rateLimiter: RateLimiterLike;
  private readonly creator: MessageCreator;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: SleepFn;
  private readonly random: () => number;

  constructor(options: LlmClientOptions) {
    llmClientOptionsSchema.parse(options);
    this.taggingModel = options.taggingModel;
    this.collectionModel = options.collectionModel;
    this.rateLimiter = options.rateLimiter;
    this.creator = options.creator;
    this.logger = options.logger ?? nullLogger;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  async tagBook(book: Book): Promise<BookTagResult> {
    const { system, user } = buildTagPrompt(book);
    const est = estimateTokens(system + user) + 512;
    const raw = await this.invoke({ model: this.taggingModel, maxTokens: 1024, system, user, responseSchema: tagResponseSchema }, est);
    const parsed = parseJsonResponse(raw.text, tagResponseSchema, this.logger, `tagBook ${book.id}`);
    return { bookId: book.id, tags: parsed.tags, usage: raw.usage };
  }

  async generateCollection(
    summary: TagSummary,
    prompt: string
  ): Promise<{ proposal: CollectionProposal; usage: TokenUsage }> {
    const { system, user } = buildCollectionPrompt(summary, prompt);
    const est = estimateTokens(system + user) + 1024;
    const raw = await this.invoke(
      { model: this.collectionModel, maxTokens: 4096, system, user, responseSchema: collectionProposalSchema },
      est
    );
    const proposal = parseJsonResponse(
      raw.text,
      collectionProposalSchema,
      this.logger,
      'generateCollection'
    );
    return { proposal, usage: raw.usage };
  }

  async autoDiscoverCollections(
    summary: TagSummary
  ): Promise<{ proposals: CollectionProposal[]; usage: TokenUsage }> {
    const { system, user } = buildAutoDiscoverPrompt(summary);
    const est = estimateTokens(system + user) + 2048;
    const raw = await this.invoke(
      { model: this.collectionModel, maxTokens: 4096, system, user, responseSchema: multiCollectionProposalSchema },
      est
    );
    const multiProposal = parseJsonResponse(
      raw.text,
      multiCollectionProposalSchema,
      this.logger,
      'autoDiscoverCollections'
    );
    return { proposals: multiProposal.collections, usage: raw.usage };
  }

  /** Rate-limit, call, and retry on transient failures with bounded backoff. */
  private async invoke(req: MessageRequest, estimatedTokens: number): Promise<RawCompletion> {
    let attempt = 0;
    for (;;) {
      await this.rateLimiter.acquire(estimatedTokens);
      try {
        const res = await this.creator.create(req);
        this.logger.debug('LLM call succeeded', { model: req.model, usage: res.usage });
        return res;
      } catch (err) {
        const classified = this.classify(err);
        if (classified.retryable && attempt < this.maxRetries) {
          const delay = this.backoff(attempt, classified.retryAfterMs);
          this.logger.warn('LLM call failed — backing off', {
            model: req.model,
            attempt: attempt + 1,
            code: classified.error.code,
            delayMs: delay,
          });
          attempt += 1;
          await this.sleep(delay);
          continue;
        }
        this.logger.error('LLM call failed permanently', {
          model: req.model,
          attempts: attempt + 1,
          code: classified.error.code,
        });
        throw classified.error;
      }
    }
  }

  private classify(err: unknown): Classified {
    if (err instanceof AppError) return { error: err, retryable: false };

    const status = readStatus(err);
    const type = readErrorType(err);
    const message = readMessage(err);

    // Billing/quota exhaustion — actionable, never retried (A2).
    if (type === 'billing_error' || /credit|quota|billing/i.test(message)) {
      return { error: new LlmQuotaError(`Anthropic quota/credit issue: ${message}`), retryable: false };
    }
    if (status === 429) {
      return {
        error: new LlmRateLimitError(`Anthropic rate limit: ${message}`, readRetryAfter(err)),
        retryable: true,
        retryAfterMs: readRetryAfter(err),
      };
    }
    if (status === 529 || (status !== undefined && status >= 500)) {
      return { error: new LlmRequestError(`Anthropic server error (${status}): ${message}`), retryable: true };
    }
    if (status === undefined && (message.includes('fetch failed') || message.includes('ECONN') || message.includes('timeout'))) {
      return { error: new LlmRequestError(`LLM network error: ${message}`), retryable: true };
    }
    if (status === 401 || status === 403) {
      return { error: new LlmRequestError(`Anthropic auth/permission error (${status}): ${message}`), retryable: false };
    }
    // 400 and anything else: not retryable.
    return { error: new LlmRequestError(message, status !== undefined ? { status } : undefined), retryable: false };
  }

  /** Full-jitter exponential backoff, capped; honors retry-after when provided. */
  private backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return retryAfterMs + Math.floor(this.random() * 250);
    }
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.max(1, Math.floor(this.random() * exp));
  }
}

function isErrorWithHeaders(err: unknown): err is { headers: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && 'headers' in err && 
         typeof (err as Record<string, unknown>).headers === 'object' && 
         (err as Record<string, unknown>).headers !== null;
}
function readRetryAfter(err: unknown): number | undefined {
  if (isErrorWithHeaders(err)) {
    const raw = err.headers['retry-after'];
    if (typeof raw === 'string') {
      const secs = Number.parseFloat(raw);
      if (Number.isFinite(secs)) return secs * 1000;
    }
  }
  return undefined;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function durationHours(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  return (seconds / 3600).toFixed(1);
}

function buildTagPrompt(book: Book): { system: string; user: string } {
  const system = `You are a librarian that classifies audiobooks for a science-fiction-leaning personal library.
Return ONLY a JSON object — no prose, no markdown fences. Shape:
{"tags":[{"tag":"<kebab-case>","category":"<category>","confidence":<0.0-1.0>}]}

Categories and example vocabulary (prefer these, but you may add close variants):
- genre: hard-sci-fi, space-opera, cyberpunk, dystopian, military-sci-fi, fantasy, thriller
- mood: dark, humorous, hopeful, tense, meditative, action-driven
- theme: first-contact, ai, time-travel, post-apocalyptic, political, survival, dystopian
- era: golden-age, new-wave, modern, classic
- pacing: slow-burn, fast-paced, episodic, dense
- length: short, medium, long, epic  (use duration: <6h=short, 6-12h=medium, 12-20h=long, >20h=epic)
- audience: adult, ya, all-ages

Provide at least one tag for each of: genre, mood, theme, era, pacing, length, audience.
Confidence reflects how sure you are. Output JSON only.`;

  const user = `Classify this audiobook:
Title: ${book.title}
Author: ${book.author ?? 'unknown'}
Series: ${book.series ?? 'none'}${book.seriesSequence !== null ? ` (#${book.seriesSequence})` : ''}
Published: ${book.publishedYear ?? 'unknown'}
Duration (hours): ${durationHours(book.durationSeconds)}
Existing genres: ${book.genres.length > 0 ? book.genres.join(', ') : 'none'}
Description: ${book.description ? book.description.slice(0, 1500) : 'none'}`;

  return { system, user };
}

function buildCollectionPrompt(
  summary: TagSummary,
  prompt: string
): { system: string; user: string } {
  const system = `You are an editorial curator building themed audiobook collections from a tagged library.
You will receive a compact list of books (id, title, author, duration, tags) and a theme request.
Pick the books that genuinely fit the theme. Return ONLY a JSON object — no prose, no fences. Shape:
{"name":"<collection name>","description":"<1-2 sentences>","bookIds":["<id>",...],"reasoning":"<short>"}
Use ONLY ids that appear in the provided list. If none fit, return an empty bookIds array.`;

  const user = `Theme request: ${prompt}

Library summary:
${JSON.stringify(summary)}`;

  return { system, user };
}

function buildAutoDiscoverPrompt(
  summary: TagSummary
): { system: string; user: string } {
  const system = `You are a Master Literary Curator analyzing a personal audiobook library.
I will provide a summary of the books in this library (id, title, tags, description).
Your task is to identify 3 to 5 highly creative, specific, and unexpected collections by finding hidden thematic patterns across these books.
Do not use generic genres (like "Sci-Fi" or "Fantasy"). Look for highly specific tropes, vibes, or scenarios. For example: "Reluctant Protagonists Overthrowing Corrupt Governments", "Cozy Intergalactic Coffee Shops", or "Existential Dread Set in Space".

For each collection, provide a creative name, a short description, and exactly the book IDs that belong to it.
Return ONLY JSON in this schema:
{"collections": [{"name":"<collection name>","description":"<1-2 sentences>","bookIds":["<id>",...],"reasoning":"<short>"}]}
Use ONLY ids that appear in the provided list.`;

  const user = `Library summary:
${JSON.stringify(summary)}`;

  return { system, user };
}

// ── Adapters ─────────────────────────────────────────────────────────────────
/** Default production MessageCreator backed by the Anthropic SDK. */


export function createAnthropicMessageCreator(apiKey: string): MessageCreator {
  const client = new Anthropic({ apiKey });
  const translator = new AnthropicErrorTranslator();

  return {
    async create(req: MessageRequest): Promise<RawCompletion> {
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        };
        
        if (req.responseSchema) {
          const jsonSchema = zodToJsonSchema(req.responseSchema) as Record<string, unknown>;
          params.tools = [{
            name: 'output',
            description: 'Output generator',
            input_schema: jsonSchema as Anthropic.Tool.InputSchema,
          }];
          params.tool_choice = { type: 'tool', name: 'output' };
        }
        
        const res = await client.messages.create(params);
        
        let text = '';
        if (req.responseSchema) {
          const toolUse = res.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
          if (toolUse && typeof toolUse.input === 'object') {
            text = JSON.stringify(toolUse.input);
          }
        }
        if (!text) {
          text = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
        }

        return {
          text,
          usage: {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
          },
        };
      } catch (err) {
        throw translator.translate(err);
      }
    },
    async *createStream(req: MessageRequest): AsyncIterableIterator<string> {
      try {
        const stream = await client.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          stream: true,
        });

        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            yield chunk.delta.text;
          }
        }
      } catch (err) {
        throw translator.translate(err);
      }
    }
  };
}

/** Fallback MessageCreator backed by a local Ollama server. */


export function createOllamaMessageCreator(url: string, logger: Logger = nullLogger): MessageCreator {
  const translator = new OllamaErrorTranslator();

  return {
    async create(req: MessageRequest): Promise<RawCompletion> {
      try {
        const res = await fetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            stream: false,
            format: req.responseSchema ? zodToJsonSchema(req.responseSchema) : "json",
            options: {
              num_predict: req.maxTokens,
            },
          }),
        });

        if (!res.ok) {
          const err = new Error(`Ollama HTTP Error`) as any;
          err.status = res.status;
          throw err;
        }

        const data = await res.json();
        return {
          text: data.message?.content ?? '',
          usage: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
          },
        };
      } catch (err) {
        throw translator.translate(err);
      }
    },
    async *createStream(req: MessageRequest): AsyncIterableIterator<string> {
      try {
        const res = await fetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            stream: true,
            options: {
              num_predict: req.maxTokens,
            },
          }),
        });

        if (!res.ok) {
          const err = new Error(`Ollama HTTP Error`) as any;
          err.status = res.status;
          throw err;
        }

        if (!res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\\n').filter(l => l.trim() !== '');
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.message?.content) yield data.message.content;
            } catch (e) {
            }
          }
        }
      } catch (err) {
        throw translator.translate(err);
      }
    }
  };
}




export class FallbackMessageCreator implements MessageCreator {
  constructor(private creators: MessageCreator[], private logger: Logger = nullLogger) {
    if (creators.length === 0) throw new Error('FallbackMessageCreator requires at least one MessageCreator');
  }
  
  async create(req: MessageRequest): Promise<RawCompletion> {
    let lastError: unknown;
    for (const [index, creator] of this.creators.entries()) {
      try {
        return await creator.create(req);
      } catch (err) {
        lastError = err;
        this.logger.warn(`Provider ${index} failed, falling back if available`, { 
          model: req.model, 
          error: err instanceof Error ? err.message : String(err) 
        });
      }
    }
    throw lastError;
  }

  async *createStream(req: MessageRequest): AsyncIterableIterator<string> {
    let lastError: unknown;
    for (const [index, creator] of this.creators.entries()) {
      try {
        const stream = creator.createStream(req);
        const first = await stream.next();
        if (!first.done) {
           yield first.value;
        }
        for await (const chunk of stream) {
           yield chunk;
        }
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(`Provider ${index} stream failed, falling back if available`, { 
          model: req.model, 
          error: err instanceof Error ? err.message : String(err) 
        });
      }
    }
    throw lastError;
  }
}
