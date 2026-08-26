/**
 * The librarian's round-loop spine (librarian engine plan §5.1, §8.1;
 * readiness item E).
 *
 * `runConversation` drives the tool loop: ask a `TurnDriver` what to do next,
 * run whatever tool calls it asks for against `LIBRARIAN_TOOLS`, and repeat
 * until it answers or the round budget runs out. It knows nothing about
 * Claude, prompts, or HTTP — those are Phase 4 proper (a real LLM-backed
 * `TurnDriver`, the `POST /librarian/chat` route, the Desk UI). This file is
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
import type { ConversationStatus, LibrarianAnswer, LibrarianEventSink } from './events.js';
import { LIBRARIAN_TOOLS, type LibrarianToolDeps } from './tools.js';

/** Default round budget (librarian engine plan §5.1: "Max ~6 tool rounds,
 *  then forced answer"). */
const DEFAULT_MAX_ROUNDS = 6;

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
  /** True on the single final call made after the round budget is spent —
   *  see the invariant-5 comment at the `exhausted` branch below for why
   *  that answer is still reported as `exhausted`, not `answered`. */
  forceAnswer: boolean;
}

export interface TurnDriver {
  next(ctx: TurnContext): Promise<TurnDecision>;
}

export interface RunConversationOptions {
  driver: TurnDriver;
  sink: LibrarianEventSink;
  toolDeps: LibrarianToolDeps;
  /** Defaults to {@link DEFAULT_MAX_ROUNDS}. */
  maxRounds?: number;
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
    return obj.results
      .filter((r): r is { bookId: string } => typeof (r as { bookId?: unknown })?.bookId === 'string')
      .map((r) => r.bookId);
  }
  return null;
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
  pile: Set<string>
): Promise<ToolCallOutcome[]> {
  const outcomes: ToolCallOutcome[] = [];
  for (const call of calls) {
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

      const candidateIds = extractCandidateIds(result);
      if (candidateIds !== null) {
        const added = candidateIds.filter((id) => !pile.has(id));
        if (added.length > 0) {
          for (const id of added) pile.add(id);
          sink.emit({ type: 'pile', added, removed: [] });
        }
      }

      outcomes.push({ tool: call.tool, input: call.input, result });
    } catch (err) {
      const message = errorMessage(err);
      sink.emit({ type: 'error', stage: 'tool', message, recoverable: true });
      outcomes.push({ tool: call.tool, input: call.input, error: message });
    }
  }
  return outcomes;
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
  const transcript: TranscriptEntry[] = [];
  const pile = new Set<string>();

  let usage = emptyUsage();
  let round = 0;
  let status: ConversationStatus = 'failed';
  let answer: LibrarianAnswer | undefined;

  try {
    while (round < maxRounds) {
      round += 1;
      const decision = await driver.next({ transcript, round, forceAnswer: false });
      usage = addUsage(usage, decision.usage);

      if (decision.kind === 'answer') {
        answer = decision.answer;
        sink.emit({ type: 'answer', recommendations: answer.recommendations });
        status = 'answered';
        return { status, rounds: round, tokensUsed: usage, answer };
      }

      const toolResults = await runToolCalls(decision.calls, toolDeps, sink, pile);
      transcript.push({ round, decision, toolResults });
    }

    // Rounds exhausted without an answer: one final forced call rather than
    // letting the feed stop silently (§5.1: "Max ~6 tool rounds, then forced
    // answer"). Deliberately reuses `round` (== maxRounds) rather than
    // incrementing it — this forced attempt isn't a new round the caller
    // paid for out of the round budget, it's the guaranteed-answer step
    // that fires once that budget is spent, so `rounds` in the outcome
    // stays truthful about how many real rounds actually ran.
    const forced = await driver.next({ transcript, round, forceAnswer: true });
    usage = addUsage(usage, forced.usage);

    if (forced.kind === 'answer') {
      answer = forced.answer;
      sink.emit({ type: 'answer', recommendations: answer.recommendations });
    }
    // else: the driver ignored `forceAnswer` and asked for more tool calls
    // anyway. There is no round budget left to run them — executing them
    // here would silently grow the loop past `maxRounds` — so they are
    // dropped and this ends exhausted with no answer attached.

    // INVARIANT 5 (docs/phase-4-readiness.md): "A check that cannot succeed
    // must report Unknown, never a confident number." Applied here: this
    // answer (when the forced call produced one) was produced under duress,
    // after the loop's real round budget ran out — it is not the answer the
    // loop would have reached given more rounds. Reporting `'answered'`
    // would be the exact same lie as a confident 0%, so this branch is
    // ALWAYS `'exhausted'`, never `'answered'`, regardless of whether the
    // forced call succeeded.
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
