/**
 * The librarian's round-loop spine (librarian engine plan §5.1, §8.1;
 * readiness item E).
 *
 * `runConversation` drives the tool loop: ask a `TurnDriver` what to do next,
 * run whatever tool calls it asks for against `LIBRARIAN_TOOLS`, and repeat
 * until it answers or one of its two budgets — rounds (§5.1) or tokens
 * (§10.I, readiness item I) — runs out. It knows nothing about
 * Claude, prompts, or HTTP — those live in the prompt driver and API/UI
 * adapters. This file is
 * deliberately the boring, generic part: a loop that can never let the event
 * feed go silent, no matter what the driver or a tool does.
 *
 * `TurnDriver` is the injected seam (AGENTS.md dependency-injection
 * discipline), one level up from `llmClient.ts`'s `MessageCreator` idiom —
 * where `MessageCreator` wraps one raw model call, `TurnDriver` wraps one
 * round of "what does the librarian do next", so Phase 4 can plug an
 * LLM-backed implementation in behind the same interface tests use here with
 * scripted drivers.
 */
import { addUsage, emptyUsage, type TokenUsage } from '../types.js';
import type { ConversationStatus, LibrarianAnswer, LibrarianEventSink, RetrievalEvent } from './events.js';
import { LIBRARIAN_TOOLS, type LibrarianToolDeps } from './tools.js';

/** Default round budget (librarian engine plan §5.1: "Max ~6 tool rounds,
 *  then forced answer"). */
const DEFAULT_MAX_ROUNDS = 6;

/**
 * Default per-conversation token budget (readiness item I, plan §10.I: "add a
 * per-conversation token budget that forces the answer when exceeded").
 *
 * Chosen to sit comfortably inside a 200k-token context window with room left
 * for the system prompt, the forced answer, and the estimator's own error
 * margin — the ceiling exists so one conversation cannot walk itself out of
 * its own context (or into an unbounded bill) while still technically obeying
 * the round budget.
 *
 * The round budget alone does not bound this. Six rounds of cheap decisions
 * over enormous tool results is well within `DEFAULT_MAX_ROUNDS` and nowhere
 * near affordable: `search_library` returns up to 100 full book cards with
 * their tags, and every one of its results also carries the `libraryCoverage`
 * disclosure block (readiness item D) at ~700–900 chars of JSON, re-sent every
 * round. Rounds and tokens are genuinely different budgets.
 */
const DEFAULT_MAX_TOKENS = 120_000;
const MAX_PILE_BOOKS = 15;

/**
 * Rough bytes-per-token ratio used by {@link estimateTokenCost}. Deliberately
 * a plain heuristic and not a tokenizer: see that function's docblock for why
 * an estimate is the honest instrument here.
 */
const CHARS_PER_TOKEN = 4;

export interface ToolCallRequest {
  tool: string;
  input: unknown;
}

/**
 * What a `TurnDriver` decided to do this round. `usage` is accumulated by
 * the loop regardless of which branch — even a round that only calls tools
 * spent tokens deciding to.
 */
export type TurnDecision =
  | { kind: 'tool_calls'; calls: ToolCallRequest[]; usage: TokenUsage }
  | { kind: 'answer'; answer: LibrarianAnswer; usage: TokenUsage };

/** Outcome of one tool call this round, recorded on the transcript regardless
 *  of whether it succeeded — a driver deciding what to do next needs to see
 *  a failed call as much as a successful one. */
export interface ToolCallOutcome {
  tool: string;
  input: unknown;
  result?: unknown;
  /** Present instead of `result` when the tool threw. */
  error?: string;
}

export interface TranscriptEntry {
  round: number;
  decision: TurnDecision;
  /** Present when `decision.kind === 'tool_calls'`: one outcome per call, in
   *  the same order. */
  toolResults?: ToolCallOutcome[];
}

export interface TurnContext {
  /** Every prior round, oldest first. Empty on round 1. */
  transcript: TranscriptEntry[];
  /** 1-indexed round number this call is deciding. */
  round: number;
  /** True on the single final call made after a budget — rounds or tokens —
   *  is spent. See the invariant-5 comment at the `exhausted` branch below
   *  for why that answer is still reported as `exhausted`, not `answered`. */
  forceAnswer: boolean;
}

export interface TurnDriver {
  next(ctx: TurnContext): Promise<TurnDecision>;
}

/**
 * Diagnostic seam for the loop's tool calls (surface-unification plan §5
 * item 2: "the librarian path logs nothing").
 *
 * Deliberately NOT the `ActionLog` class and deliberately not the event sink:
 * the sink is the user-facing §8.1 contract, this is the operator-facing
 * troubleshooting record, and the loop must stay ignorant of HTTP, the action
 * log's level vocabulary, and the surrounding operation id. `api/routes/
 * librarian.ts` binds one of these to `ActionLog.forOperation(turnId)`; tests
 * pass a recorder. Never given a tool's raw input or its result — a librarian
 * result carries library content that has no business in a log line (same
 * rule `persistence.ts` applies to its write-error reporter).
 *
 * `error` IS the tool's own message, and that is a deliberate exception with
 * a known cost: a schema rejection quotes the offending value, so a fragment
 * of the model's tool arguments (which are derived from the user's question)
 * can appear in `GET /api/system/logs`. That is the single most useful field
 * for diagnosing a failing turn — the reason this seam exists — and it stays
 * inside the operator's own log, so it is recorded rather than redacted. It
 * is not a route for secrets: nothing here ever sees one.
 */
export interface ConversationToolLog {
  toolCall(info: { round: number; tool: string; ok: boolean; durationMs: number; error?: string }): void;
}

export interface RunConversationOptions {
  driver: TurnDriver;
  sink: LibrarianEventSink;
  toolDeps: LibrarianToolDeps;
  /** Optional operator-facing diagnostics. Absent in tests that only assert
   *  on the event feed; a throw from it must never cost the user an answer. */
  log?: ConversationToolLog;
  /** Defaults to {@link DEFAULT_MAX_ROUNDS}. */
  maxRounds?: number;
  /**
   * Per-conversation token ceiling. Once the loop's running estimate of what
   * this conversation has cost reaches it, no further normal round starts and
   * the forced-answer step fires — see {@link DEFAULT_MAX_TOKENS} (the
   * default) and {@link estimateTokenCost} (what "estimate" means here).
   * Bounds the LOOP, never the guaranteed answer: the forced call runs even
   * when the ceiling is already blown, because a budget that could swallow
   * the answer would reintroduce the silent feed §10.E exists to fix.
   */
  maxTokens?: number;
}

export interface ConversationOutcome {
  status: ConversationStatus;
  rounds: number;
  tokensUsed: TokenUsage;
  /** Present whenever an answer was produced — on both `'answered'` and
   *  `'exhausted'` (the forced round can still succeed). Absent on
   *  `'failed'`. */
  answer?: LibrarianAnswer;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Approximate token cost of a value that will be fed back to the driver
 * (readiness item I).
 *
 * WHY AN ESTIMATE, AND WHY IT NEVER LEAVES THE BUDGET. A tool result's real
 * cost is only ever *measured* on the next driver call, as part of that
 * call's `usage.inputTokens` — by which point the loop has already paid it.
 * A ceiling that only counted measured driver usage would therefore be blind
 * to the single largest line item in this loop (see {@link
 * DEFAULT_MAX_TOKENS}) and would let a conversation with cheap decisions and
 * enormous results run its full round budget. So results are charged the
 * moment they land, estimated.
 *
 * Because it is an estimate, it feeds the budget decision ONLY. It is never
 * added to `tokensUsed`, which stays exactly what the driver reported — a
 * measurement. Mixing a heuristic into a reported figure would be invariant 5
 * (docs/phase-4-readiness.md) in its usual disguise: a number nobody actually
 * counted, presented as one that was.
 *
 * The estimate deliberately errs high rather than low. A charged result is
 * also billed again as input tokens on the next real driver call, so the
 * budget double-counts it slightly; undercounting is the failure this ceiling
 * exists to prevent, so the conservative direction is the correct one.
 */
function estimateTokenCost(value: unknown): number {
  if (value === undefined) return 0;
  let serialized: string;
  try {
    // A tool result that cannot be serialized still costs something to send;
    // fall back rather than letting the estimator throw and take the
    // conversation with it.
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

/** Estimated cost of one round's tool results, charged to the budget as soon
 *  as they land. A failed call still costs its error message — the driver
 *  sees it on the transcript and pays for it next round like any other
 *  result. */
function estimateToolResultCost(outcomes: ToolCallOutcome[]): number {
  let total = 0;
  for (const outcome of outcomes) {
    total += estimateTokenCost(outcome.result);
    total += estimateTokenCost(outcome.error);
  }
  return total;
}

/**
 * Curated, server-side digest for an `action` event's `detail`/
 * `resultSummary` — §8.3 is explicit that these are "never raw JSON args".
 * The tool→verb rendering table in §8.3 ("Browsing the stacks for…") is Desk
 * UI presentation work for a later phase; this spine's job is only to
 * guarantee neither field is ever a raw dump of a tool's input or output.
 */
function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value !== null && typeof value === 'object') return '{…}';
  return String(value);
}

function digestInput(input: unknown): string {
  if (input === null || input === undefined) return '(no input)';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '(no filters)';
  return entries.map(([k, v]) => `${k}: ${summarizeValue(v)}`).join(', ');
}

function digestResult(result: unknown): string {
  if (result === null || result === undefined) return '(no result)';
  if (Array.isArray(result)) return `${result.length} result(s)`;
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.books)) return `${obj.books.length} book(s)`;
    if (Array.isArray(obj.results)) return `${obj.results.length} result(s)`;
    if ('book' in obj) return '1 book';
    if (typeof obj.total === 'number') return `${obj.total} total`;
  }
  return 'done';
}

/**
 * Book ids a tool result adds to the browsing pile (§8.4), when the result
 * shape carries one. Only `search_library` (`{ books: [...] }`) and
 * `find_similar` (`{ results: [...] }`) generate candidates; `get_book` and
 * `tag_coverage` don't, so they return `null` here and never emit a `pile`
 * event. `removed` is deliberately never populated by this spine — knowing
 * *why* a book left the pile (filter demotion, exclusion) is real ranking
 * logic that belongs to the LLM-backed driver of a later phase, not
 * something this generic tool-calling loop can honestly infer.
 */
function extractCandidateIds(result: unknown): string[] | null {
  if (result === null || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.books)) {
    return obj.books
      .filter((b): b is { id: string } => typeof (b as { id?: unknown })?.id === 'string')
      .map((b) => b.id);
  }
  if (Array.isArray(obj.results)) {
    return obj.results.flatMap((result) => {
      if (result === null || typeof result !== 'object') return [];
      const row = result as Record<string, unknown>;
      if (typeof row.bookId === 'string') return [row.bookId];
      if (row.book !== null && typeof row.book === 'object') {
        const id = (row.book as Record<string, unknown>).id;
        if (typeof id === 'string') return [id];
      }
      return [];
    });
  }
  return null;
}

/**
 * Produce coverage disclosures only from the successful, typed shape returned
 * by `tag_coverage`. The driver may describe that result in its eventual
 * answer, but it must not be the source of this trace: these counts are the
 * database's three-state classification, not model prose.
 */
export function extractCoverageAudits(result: unknown): Array<{ note: string; flaggedBookIds?: string[] }> {
  if (result === null || typeof result !== 'object' || !Array.isArray((result as { entries?: unknown }).entries)) return [];

  const audits: Array<{ note: string; flaggedBookIds?: string[] }> = [];
  for (const entry of (result as { entries: unknown[] }).entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const bucket = (name: string): { count: number; bookIds: string[] } | null => {
      const candidate = value[name];
      if (candidate === null || typeof candidate !== 'object' || !Array.isArray((candidate as { bookIds?: unknown }).bookIds)) return null;
      const { count, bookIds } = candidate as { count?: unknown; bookIds: unknown[] };
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !bookIds.every((id) => typeof id === 'string')) return null;
      return { count, bookIds };
    };
    const present = bucket('present');
    const absent = bucket('absent');
    const unaudited = bucket('unaudited');
    if (typeof value.tag !== 'string' || (value.category !== null && typeof value.category !== 'string') || !present || !absent || !unaudited) continue;

    const category = value.category === null ? 'unresolved category' : value.category;
    const note = `Tag coverage for “${value.tag}” (${category}): ${present.count} present, ${absent.count} confirmed absent, ${unaudited.count} unaudited.`;
    audits.push(unaudited.bookIds.length > 0 ? { note, flaggedBookIds: unaudited.bookIds } : { note });
  }
  return audits;
}

/**
 * Turn a retrieval tool's own typed result into the §2.2-step-2 audit
 * disclosure, or `null` when the result is not one.
 *
 * Read strictly and by shape, exactly like {@link extractCoverageAudits}: the
 * numbers reported to the user must come from the tool's measurement, so a
 * result missing any of them produces no event at all rather than a defaulted
 * zero. `tagResolution` and `relaxation` are optional in the source shape and
 * stay optional here.
 */
export function extractRetrievalDisclosure(
  tool: string,
  result: unknown
): Omit<RetrievalEvent, 'type'> | null {
  if (result === null || typeof result !== 'object') return null;
  const value = result as Record<string, unknown>;
  if (
    typeof value.total !== 'number' ||
    typeof value.semanticScored !== 'number' ||
    typeof value.personalized !== 'boolean' ||
    !Array.isArray(value.results)
  ) return null;

  const notes: RetrievalEvent['tagResolution'] = [];
  if (Array.isArray(value.tagResolution)) {
    for (const note of value.tagResolution) {
      if (note === null || typeof note !== 'object') continue;
      const row = note as Record<string, unknown>;
      if (
        typeof row.field !== 'string' ||
        typeof row.from !== 'string' ||
        typeof row.reason !== 'string' ||
        !Array.isArray(row.to) ||
        !row.to.every((entry) => typeof entry === 'string')
      ) continue;
      notes.push({ field: row.field, from: row.from, to: row.to as string[], reason: row.reason });
    }
  }

  let relaxation: RetrievalEvent['relaxation'] = null;
  const rawRelaxation = value.relaxation;
  if (rawRelaxation !== null && typeof rawRelaxation === 'object' && Array.isArray((rawRelaxation as { demotedTags?: unknown }).demotedTags)) {
    const demotedTags: Array<{ tag: string; category?: string }> = [];
    for (const entry of (rawRelaxation as { demotedTags: unknown[] }).demotedTags) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.tag !== 'string') continue;
      demotedTags.push({ tag: row.tag, ...(typeof row.category === 'string' ? { category: row.category } : {}) });
    }
    relaxation = { demotedTags };
  }

  return {
    tool,
    candidateCount: value.total,
    evidenceCount: value.results.length,
    semanticScored: value.semanticScored,
    personalized: value.personalized,
    ...(notes.length > 0 ? { tagResolution: notes } : {}),
    relaxation,
  };
}

/**
 * `LIBRARIAN_TOOLS` is typed as a union of concrete tool shapes (see
 * tools.ts), so dispatching by name against arbitrary driver input needs a
 * type-erased view rather than a per-call cast. A single `as unknown as`
 * here (not a literal `any`) buys that without tripping `no-explicit-any` —
 * `tools.test.ts`'s `callTool` takes the `any`-cast route instead, but that
 * file is exempt from the rule; this one is production code, where the
 * baseline must not grow.
 */
interface ErasedLibrarianTool {
  name: string;
  inputSchema: { parse(input: unknown): unknown };
  handler: (deps: LibrarianToolDeps, input: unknown) => unknown;
}
const ERASED_TOOLS = LIBRARIAN_TOOLS as unknown as ErasedLibrarianTool[];

/**
 * Runs every tool call for one round. A tool throwing is recoverable — it
 * emits `error{stage:'tool', recoverable:true}` and the loop carries on; it
 * must NEVER abort the conversation, since a single bad call (unknown book
 * id, malformed filter) shouldn't cost the user the whole answer when the
 * driver can just try something else next round.
 */
async function runToolCalls(
  calls: ToolCallRequest[],
  toolDeps: LibrarianToolDeps,
  sink: LibrarianEventSink,
  pile: Set<string>,
  round: number,
  log?: ConversationToolLog
): Promise<ToolCallOutcome[]> {
  const outcomes: ToolCallOutcome[] = [];
  for (const call of calls) {
    const startedAt = Date.now();
    try {
      const tool = ERASED_TOOLS.find((t) => t.name === call.tool);
      if (!tool) throw new Error(`Unknown librarian tool: ${call.tool}`);
      const parsedInput = tool.inputSchema.parse(call.input);
      const result = await tool.handler(toolDeps, parsedInput);

      sink.emit({
        type: 'action',
        tool: call.tool,
        label: call.tool,
        detail: digestInput(call.input),
        resultSummary: digestResult(result),
      });

      if (call.tool === 'tag_coverage') {
        for (const audit of extractCoverageAudits(result)) sink.emit({ type: 'audit', ...audit });
      }

      const disclosure = extractRetrievalDisclosure(call.tool, result);
      if (disclosure) sink.emit({ type: 'retrieval', ...disclosure });

      const candidateIds = extractCandidateIds(result);
      if (candidateIds !== null) {
        const remaining = MAX_PILE_BOOKS - pile.size;
        const added = remaining > 0 ? candidateIds.filter((id) => !pile.has(id)).slice(0, remaining) : [];
        if (added.length > 0) {
          for (const id of added) pile.add(id);
          sink.emit({ type: 'pile', added, removed: [] });
        }
      }

      outcomes.push({ tool: call.tool, input: call.input, result });
      recordToolCall(log, { round, tool: call.tool, ok: true, durationMs: Date.now() - startedAt });
    } catch (err) {
      const message = errorMessage(err);
      sink.emit({ type: 'error', stage: 'tool', message, recoverable: true });
      outcomes.push({ tool: call.tool, input: call.input, error: message });
      recordToolCall(log, { round, tool: call.tool, ok: false, durationMs: Date.now() - startedAt, error: message });
    }
  }
  return outcomes;
}

/** Diagnostics must never be able to end a conversation: a logger that throws
 *  is a broken logger, not a broken answer. */
function recordToolCall(log: ConversationToolLog | undefined, info: Parameters<ConversationToolLog['toolCall']>[0]): void {
  if (!log) return;
  try {
    log.toolCall(info);
  } catch {
    // Intentionally ignored — see the docblock above.
  }
}

/**
 * Drives the round loop to a terminal `done` event. Every exit path — an
 * early answer, exhausted rounds, or an unrecoverable throw — funnels
 * through the `finally` below so exactly one `done` is always emitted, and
 * always last: a feed that stops silently is indistinguishable from "still
 * thinking", which is the bug this readiness item exists to fix.
 */
export async function runConversation(options: RunConversationOptions): Promise<ConversationOutcome> {
  const { driver, sink, toolDeps } = options;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const transcript: TranscriptEntry[] = [];
  const pile = new Set<string>();

  let usage = emptyUsage();
  /**
   * Running budget spend (readiness item I). Distinct from `usage` on
   * purpose, and never reported: `usage` is what the driver measured, this is
   * that plus an *estimate* of every tool result handed back (see
   * {@link estimateTokenCost}). The two must not be conflated — one is a
   * measurement, the other is a heuristic the loop steers by.
   */
  let budgetSpend = 0;
  let round = 0;
  let status: ConversationStatus = 'failed';
  let answer: LibrarianAnswer | undefined;

  try {
    while (round < maxRounds && budgetSpend < maxTokens) {
      round += 1;
      const decision = await driver.next({ transcript, round, forceAnswer: false });
      usage = addUsage(usage, decision.usage);
      budgetSpend += decision.usage.inputTokens + decision.usage.outputTokens;

      if (decision.kind === 'answer') {
        answer = decision.answer;
        sink.emit({ type: 'answer', recommendations: answer.recommendations });
        status = 'answered';
        return { status, rounds: round, tokensUsed: usage, answer };
      }

      const toolResults = await runToolCalls(decision.calls, toolDeps, sink, pile, round, options.log);
      // Charged here, before the loop condition is re-tested, so a round that
      // pulled back an enormous result cannot be followed by another one.
      budgetSpend += estimateToolResultCost(toolResults);
      transcript.push({ round, decision, toolResults });
    }

    // A budget ran out without an answer — either the round budget (§5.1:
    // "Max ~6 tool rounds, then forced answer") or the token budget
    // (§10.I). One final forced call, rather than letting the feed stop
    // silently. Deliberately reuses `round` rather than incrementing it —
    // this forced attempt isn't a new round the caller paid for out of the
    // round budget, it's the guaranteed-answer step that fires once a budget
    // is spent, so `rounds` in the outcome stays truthful about how many real
    // rounds actually ran. It fires even when the token ceiling is already
    // blown: the ceiling bounds the loop, never the answer.
    const forced = await driver.next({ transcript, round, forceAnswer: true });
    usage = addUsage(usage, forced.usage);

    if (forced.kind === 'answer') {
      answer = forced.answer;
      sink.emit({ type: 'answer', recommendations: answer.recommendations });
    }
    // else: the driver ignored `forceAnswer` and asked for more tool calls
    // anyway. There is no budget left to run them — executing them here
    // would silently grow the loop past `maxRounds`, or spend past
    // `maxTokens` — so they are dropped and this ends exhausted with no
    // answer attached.

    // INVARIANT 5 (docs/phase-4-readiness.md): "A check that cannot succeed
    // must report Unknown, never a confident number." Applied here: this
    // answer (when the forced call produced one) was produced under duress,
    // after one of the loop's real budgets ran out — it is not the answer the
    // loop would have reached given more rounds or more tokens. Reporting
    // `'answered'` would be the exact same lie as a confident 0%, so this
    // branch is ALWAYS `'exhausted'`, never `'answered'`, regardless of
    // whether the forced call succeeded. The token ceiling reports exactly
    // like the round ceiling for the same reason — the reason the answer was
    // rushed differs, but "rushed" is the fact the caller must not lose.
    status = 'exhausted';
    return { status, rounds: round, tokensUsed: usage, answer };
  } catch (err) {
    // The driver threw (on either a normal or the forced round) — not
    // recoverable, unlike a tool throwing inside runToolCalls above. Also
    // catches any other unanticipated throw in this function, per the
    // `finally` guarantee below.
    sink.emit({ type: 'error', stage: 'driver', message: errorMessage(err), recoverable: false });
    status = 'failed';
    return { status, rounds: round, tokensUsed: usage, answer };
  } finally {
    // The terminal event, emitted from `finally` so that EVERY exit path —
    // the answer return, the exhausted return, the catch, and any throw this
    // function does not anticipate — ends the stream with exactly one `done`.
    // A feed that stops without one is indistinguishable from "still
    // thinking", which is the bug §10.E exists to fix. `status`, `round` and
    // `usage` are read here rather than passed in, so the values reported are
    // whatever the loop actually reached.
    sink.emit({ type: 'done', status, rounds: round, tokensUsed: usage });
  }
}
