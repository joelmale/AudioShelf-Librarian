/**
 * The librarian's round-loop spine (readiness item E, plan §5.1/§8.1).
 *
 * Drives `runConversation` with scripted `TurnDriver`s (no LLM, no network —
 * a real LLM-backed driver is Phase 4 proper) and asserts against the
 * recorded event stream, one test per terminal status plus the tool-error
 * recoverability case. `get_book` against a nonexistent id is used for the
 * tool-throws case specifically because it is a REAL throw from an actual
 * `LIBRARIAN_TOOLS` handler (same `NotFoundError` `tools.test.ts` exercises
 * directly), not a mocked failure — this spine's job is to survive whatever
 * a real tool actually does, not a stand-in for it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import type { DoneEvent, ErrorEvent, LibrarianEvent } from './events.js';
import { RecordingLibrarianEventSink } from './events.js';
import { runConversation, type TurnDriver } from './conversation.js';
import { createStubEmbeddingCreator } from '../retrieval/fixtures/stubEmbedder.js';
import type { LibrarianToolDeps } from './tools.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function deps(db: CuratorDb): LibrarianToolDeps {
  return { db, embeddingModel: 'stub-model', embeddingCreator: createStubEmbeddingCreator() };
}

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'> & Partial<Book>): void {
  db.upsertBook({
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...input,
  });
}

/**
 * Shared structural assertion (readiness item E's verification standard,
 * point 5): exactly one `done` event in the stream, and it is the LAST
 * element — a feed that stops without one is indistinguishable from "still
 * thinking", which is the bug this item exists to fix. Applied to every
 * test below.
 */
function assertDoneIsTerminal(events: LibrarianEvent[]): DoneEvent {
  const doneEvents = events.filter((e): e is DoneEvent => e.type === 'done');
  expect(doneEvents).toHaveLength(1);
  expect(events.length).toBeGreaterThan(0);
  expect(events[events.length - 1]).toBe(doneEvents[0]);
  return doneEvents[0];
}

describe('runConversation', () => {
  it('answers on round 1 -> done{status: "answered", rounds: 1}', async () => {
    const sink = new RecordingLibrarianEventSink();
    const driver: TurnDriver = {
      next: async () => ({
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'b1', reason: 'a great fit' }] },
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    const outcome = await runConversation({ driver, sink, toolDeps: deps(makeDb()) });

    expect(outcome.status).toBe('answered');
    expect(outcome.rounds).toBe(1);
    expect(outcome.tokensUsed).toEqual({ inputTokens: 10, outputTokens: 5 });

    const answerEvents = sink.events.filter((e) => e.type === 'answer');
    expect(answerEvents).toHaveLength(1);

    const done = assertDoneIsTerminal(sink.events);
    expect(done).toEqual({
      type: 'done',
      status: 'answered',
      rounds: 1,
      tokensUsed: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('never answers within maxRounds -> forced answer IS emitted, done{status: "exhausted", rounds: 3}', async () => {
    const sink = new RecordingLibrarianEventSink();
    let calls = 0;
    const driver: TurnDriver = {
      next: async (ctx) => {
        calls += 1;
        if (ctx.forceAnswer) {
          return {
            kind: 'answer',
            answer: { recommendations: [{ reason: 'the best I could do under duress' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return { kind: 'tool_calls', calls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const outcome = await runConversation({ driver, sink, toolDeps: deps(makeDb()), maxRounds: 3 });

    // 3 normal rounds, all `tool_calls`, then exactly one forced call.
    expect(calls).toBe(4);

    const answerEvents = sink.events.filter((e) => e.type === 'answer');
    expect(answerEvents).toHaveLength(1); // the forced answer IS emitted

    // INVARIANT 5 (docs/phase-4-readiness.md): "A check that cannot succeed
    // must report Unknown, never a confident number." This answer was
    // produced under duress after the round budget ran out — it is not the
    // answer the loop would have reached with more rounds. Reporting it as
    // 'answered' would be the exact same lie as a confident 0%. Asserted as
    // its own expectation (not folded into the `done.status` check below) so
    // a regression that flips the exhausted branch to report 'answered'
    // fails here explicitly, not just incidentally.
    expect(outcome.status).not.toBe('answered');
    expect(outcome.status).toBe('exhausted');

    const done = assertDoneIsTerminal(sink.events);
    expect(done.status).toBe('exhausted');
    expect(done.rounds).toBe(3);
  });

  it('driver throws -> error{recoverable: false} then done{status: "failed"}', async () => {
    const sink = new RecordingLibrarianEventSink();
    const driver: TurnDriver = {
      next: async () => {
        throw new Error('driver blew up');
      },
    };

    const outcome = await runConversation({ driver, sink, toolDeps: deps(makeDb()) });

    expect(outcome.status).toBe('failed');
    expect(outcome.answer).toBeUndefined();

    const errorEvents = sink.events.filter((e): e is ErrorEvent => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toEqual({
      type: 'error',
      stage: 'driver',
      message: 'driver blew up',
      recoverable: false,
    });

    const done = assertDoneIsTerminal(sink.events);
    expect(done.status).toBe('failed');
  });

  it('a tool throws, then the driver answers next round -> recoverable tool error, run still ends answered', async () => {
    const sink = new RecordingLibrarianEventSink();
    let round = 0;
    const driver: TurnDriver = {
      next: async () => {
        round += 1;
        if (round === 1) {
          // 'missing' does not exist in this empty in-memory db, so
          // get_book's handler genuinely throws NotFoundError.
          return {
            kind: 'tool_calls',
            calls: [{ tool: 'get_book', input: { id: 'missing' } }],
            usage: { inputTokens: 2, outputTokens: 2 },
          };
        }
        return {
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'b1', reason: 'found on the second try' }] },
          usage: { inputTokens: 3, outputTokens: 3 },
        };
      },
    };

    const outcome = await runConversation({ driver, sink, toolDeps: deps(makeDb()) });

    // Proves `recoverable` is load-bearing, not decorative: a tool error
    // does not abort the conversation, the driver gets to try again, and
    // the run still ends 'answered'.
    expect(outcome.status).toBe('answered');
    expect(outcome.rounds).toBe(2);

    const errorEvents = sink.events.filter((e): e is ErrorEvent => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].stage).toBe('tool');
    expect(errorEvents[0].recoverable).toBe(true);
    expect(errorEvents[0].message).toContain('missing');

    // No `action` event for the failed call — only a real result gets one.
    const actionEvents = sink.events.filter((e) => e.type === 'action');
    expect(actionEvents).toHaveLength(0);

    const done = assertDoneIsTerminal(sink.events);
    expect(done.status).toBe('answered');
  });

  it('adds semantic-search book cards to the candidate pile', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Rain on the Harbor', description: 'A reflective coastal mystery.' });
    const sink = new RecordingLibrarianEventSink();
    let round = 0;
    const driver: TurnDriver = {
      next: async () => {
        round += 1;
        if (round === 1) {
          return {
            kind: 'tool_calls',
            calls: [{ tool: 'search_semantic', input: { query: 'rainy coastal mystery' } }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'b1', reason: 'The semantic result matched.' }] },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    await runConversation({ driver, sink, toolDeps: deps(db) });

    expect(sink.events.filter((event) => event.type === 'pile')).toEqual([
      { type: 'pile', added: ['b1'], removed: [] },
    ]);
  });
});

/**
 * The per-conversation TOKEN budget (readiness item I, plan §10.I). Separate
 * from the round budget above and separately load-bearing: the two clauses of
 * the budget — what the driver reported, and what the tool results cost — are
 * each exercised by a test where the OTHER clause contributes nothing, so
 * neutralizing either one is caught here rather than silently absorbed by the
 * other (readiness invariant 7: "ask which clause does nothing test").
 *
 * `maxRounds` is set generously in both exhaustion cases so that a run
 * reaching the forced answer proves the TOKEN ceiling fired — a round-budget
 * regression would show up as `rounds` climbing to `maxRounds`.
 */
describe('runConversation — token budget', () => {
  it('driver usage alone exhausts the budget: forced answer, exhausted, far short of maxRounds', async () => {
    const sink = new RecordingLibrarianEventSink();
    let forcedCalls = 0;
    const driver: TurnDriver = {
      next: async (ctx) => {
        if (ctx.forceAnswer) {
          forcedCalls += 1;
          return {
            kind: 'answer',
            answer: { recommendations: [{ bookId: 'b1', reason: 'answered on the last of the budget' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        // No tool calls at all, so tool-result accounting contributes
        // nothing: this case is about the driver's own reported usage.
        return { kind: 'tool_calls', calls: [], usage: { inputTokens: 40, outputTokens: 20 } };
      },
    };

    const outcome = await runConversation({
      driver,
      sink,
      toolDeps: deps(makeDb()),
      maxRounds: 12,
      maxTokens: 100,
    });

    // 60 spent after round 1 (under 100, so round 2 starts), 120 after round
    // 2 — the ceiling stops the loop there, nine rounds early.
    expect(outcome.rounds).toBe(2);
    expect(forcedCalls).toBe(1);

    // THE EXIT CRITERION: a budget-exhausted conversation still answers.
    expect(outcome.answer).toBeDefined();
    expect(sink.events.filter((e) => e.type === 'answer')).toHaveLength(1);

    // Same invariant-5 reasoning as the round-exhausted case: an answer
    // produced under duress is not the answer the loop would have reached,
    // so it is never reported as 'answered'.
    expect(outcome.status).not.toBe('answered');
    expect(outcome.status).toBe('exhausted');

    const done = assertDoneIsTerminal(sink.events);
    expect(done.status).toBe('exhausted');
    expect(done.rounds).toBe(2);
    // Measured driver usage, including the forced round: 2 × (40+20) plus
    // (1+1).
    expect(done.tokensUsed).toEqual({ inputTokens: 81, outputTokens: 41 });
  });

  it('an enormous tool result exhausts the budget even though the driver reports zero usage', async () => {
    const db = makeDb();
    // A real `search_library` result over a real (if lopsided) row — the
    // thing the ceiling exists to bound is tool output, and a stub result
    // would prove only that the estimator can measure a string this test
    // wrote. 24k chars of description is ~6k estimated tokens against a
    // 2000-token ceiling.
    addBook(db, { id: 'b1', title: 'The Long One', description: 'x'.repeat(24_000) });

    const sink = new RecordingLibrarianEventSink();
    const driver: TurnDriver = {
      next: async (ctx) => {
        if (ctx.forceAnswer) {
          return {
            kind: 'answer',
            answer: { recommendations: [{ bookId: 'b1', reason: 'forced once the results blew the ceiling' }] },
            // Zero here too, so the assertion below about `tokensUsed`
            // measures only what the driver actually reported.
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        return {
          kind: 'tool_calls',
          calls: [{ tool: 'search_library', input: {} }],
          // The driver itself is free. Every token charged to the budget in
          // this test comes from the tool result, which is exactly the spend
          // a driver-usage-only budget would be blind to.
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };

    const outcome = await runConversation({
      driver,
      sink,
      toolDeps: deps(db),
      maxRounds: 12,
      maxTokens: 2000,
    });

    // One round's results were enough. Without tool-result accounting this
    // conversation is free and runs all 12.
    expect(outcome.rounds).toBe(1);
    expect(outcome.status).toBe('exhausted');
    expect(outcome.answer).toBeDefined();
    expect(sink.events.filter((e) => e.type === 'answer')).toHaveLength(1);

    // INVARIANT 5: the estimate steers the budget and is NEVER reported as a
    // measurement. The driver reported nothing, so `tokensUsed` is zero — a
    // report that quietly folded in the ~6000 estimated tokens would be a
    // number nobody counted, presented as one that was.
    const done = assertDoneIsTerminal(sink.events);
    expect(done.tokensUsed).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('does not force an answer while the conversation stays under budget', async () => {
    // The mirror-image failure: a ceiling that always fires looks identical
    // to a working one in the two tests above. Same shape as the second case
    // — real tool calls, real results — with headroom.
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'The Long One', description: 'x'.repeat(24_000) });

    const sink = new RecordingLibrarianEventSink();
    let round = 0;
    const driver: TurnDriver = {
      next: async (ctx) => {
        expect(ctx.forceAnswer).toBe(false);
        round += 1;
        if (round < 3) {
          return {
            kind: 'tool_calls',
            calls: [{ tool: 'search_library', input: {} }],
            usage: { inputTokens: 500, outputTokens: 100 },
          };
        }
        return {
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'b1', reason: 'reached on its own terms' }] },
          usage: { inputTokens: 500, outputTokens: 100 },
        };
      },
    };

    const outcome = await runConversation({
      driver,
      sink,
      toolDeps: deps(db),
      maxRounds: 12,
      maxTokens: 200_000,
    });

    expect(outcome.status).toBe('answered');
    expect(outcome.rounds).toBe(3);
    const done = assertDoneIsTerminal(sink.events);
    expect(done.status).toBe('answered');
  });
});
