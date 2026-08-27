/**
 * Phase 4's four named query archetypes through the real prompt driver,
 * conversation loop, retrieval tools, and deterministic 30-book fixture.
 * The MessageCreator is scripted, so this proves orchestration and trust
 * boundaries without a network or a nondeterministic model judgment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { MessageCreator, MessageRequest, RawCompletion } from '../llmClient.js';
import { composeBookCardFromDb } from '../retrieval/bookCard.js';
import { FIXTURE_BOOKS, seedFixtureLibrary } from '../retrieval/fixtures/library.js';
import { createStubEmbeddingCreator, stubEmbed } from '../retrieval/fixtures/stubEmbedder.js';
import { runConversation } from './conversation.js';
import { createPromptTurnDriver } from './driver.js';
import { RecordingLibrarianEventSink } from './events.js';

const MODEL = 'stub';
let db: CuratorDb;

beforeEach(() => {
  db = new CuratorDb(':memory:');
  seedFixtureLibrary(db);
  for (const fixture of FIXTURE_BOOKS) {
    const card = composeBookCardFromDb(db, fixture.id);
    if (!card) throw new Error(`No fixture card for ${fixture.id}`);
    db.upsertBookEmbedding({
      bookId: fixture.id,
      model: MODEL,
      cardHash: card.hash,
      vector: stubEmbed(card.text),
    });
  }
});

afterEach(() => db.close());

class ScriptedCreator implements MessageCreator {
  readonly requests: MessageRequest[] = [];
  private index = 0;

  constructor(private readonly decisions: unknown[]) {}

  async create(request: MessageRequest): Promise<RawCompletion> {
    this.requests.push(request);
    const decision = this.decisions[this.index];
    this.index += 1;
    if (decision === undefined) throw new Error('ScriptedCreator ran out of decisions');
    return {
      text: JSON.stringify(decision),
      usage: { inputTokens: 10 * this.index, outputTokens: 2 * this.index },
    };
  }

  createStream(): AsyncIterableIterator<string> {
    throw new Error('not used');
  }
}

async function run(question: string, decisions: unknown[]) {
  const creator = new ScriptedCreator(decisions);
  const sink = new RecordingLibrarianEventSink();
  const outcome = await runConversation({
    driver: createPromptTurnDriver({ creator, model: 'test-model', question }),
    sink,
    toolDeps: {
      db,
      embeddingModel: MODEL,
      embeddingCreator: createStubEmbeddingCreator(),
    },
  });
  return { creator, sink, outcome };
}

function actionTools(sink: RecordingLibrarianEventSink): string[] {
  return sink.events.flatMap((event) => event.type === 'action' ? [event.tool] : []);
}

describe('librarian query archetypes', () => {
  it('vibe and atmosphere: semantic prose retrieves the hand-labelled coastal ordering', async () => {
    const result = await run('Autumn in an old coastal town, melancholic and a little mysterious', [
      {
        kind: 'tool_calls',
        calls: [{
          tool: 'search_semantic',
          input: {
            query: 'melancholic coastal autumn',
            preferredTags: [
              { tag: 'melancholic', category: 'mood' },
              { tag: 'coastal-town', category: 'setting' },
              { tag: 'autumn', category: 'setting' },
            ],
            limit: 5,
          },
        }],
      },
      {
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'fx-01', reason: 'It matches all three requested facets.' }] },
      },
    ]);

    expect(result.outcome.status).toBe('answered');
    expect(result.outcome.answer?.recommendations[0]).toMatchObject({
      bookId: 'fx-01',
      title: 'The Lighthouse at Bell Harbor',
    });
    expect(actionTools(result.sink)).toEqual(['search_semantic']);
    expect(result.creator.requests[1]?.user).toContain('"id":"fx-01"');
  });

  it('cross-domain: opens the owned anchor, then finds its across-genre structural neighbour', async () => {
    const result = await run('The Ember Armada, but as low-stakes fantasy with an ensemble cast', [
      { kind: 'tool_calls', calls: [{ tool: 'get_book', input: { id: 'fx-13' } }] },
      { kind: 'tool_calls', calls: [{ tool: 'find_similar', input: { bookId: 'fx-13', acrossGenre: true, k: 5 } }] },
      {
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'fx-20', reason: 'It carries the ensemble structure into cozy fantasy.' }] },
      },
    ]);

    expect(result.outcome.answer?.recommendations[0]).toMatchObject({
      bookId: 'fx-20',
      title: 'The Ember Court Assembly',
    });
    expect(actionTools(result.sink)).toEqual(['get_book', 'find_similar']);
  });

  it('context and cognitive load: a hard duration bound survives semantic ranking', async () => {
    const result = await run('Fast and punchy for a commute, no longer than twelve hours', [
      {
        kind: 'tool_calls',
        calls: [{
          tool: 'search_semantic',
          input: {
            query: 'fast punchy commute',
            allTags: [{ tag: 'fast-paced', category: 'pacing' }],
            maxDurationHours: 12,
            limit: 10,
          },
        }],
      },
      {
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'fx-14', reason: 'It is fast-paced and eleven hours long.' }] },
      },
    ]);

    expect(result.outcome.answer?.recommendations[0]).toMatchObject({ bookId: 'fx-14', title: 'Cold Vector' });
    const secondPrompt = result.creator.requests[1]?.user ?? '';
    expect(secondPrompt).toContain('"durationSeconds":39600');
    expect(secondPrompt).not.toContain('"id":"fx-10"');
  });

  it('negative guardrails: excludes untrusted time-travel evidence and audits coverage before answering', async () => {
    const result = await run('Sprawling science fiction, but absolutely no time travel or chosen-one plot', [
      {
        kind: 'tool_calls',
        calls: [{
          tool: 'search_semantic',
          input: {
            query: 'sprawling political science fiction',
            anyTags: [
              { tag: 'science-fiction', category: 'genre' },
              { tag: 'space-opera', category: 'genre' },
            ],
            excludeTags: [
              { tag: 'time-travel', category: 'trope' },
              { tag: 'chosen-one', category: 'trope' },
            ],
            trustedOnly: true,
            limit: 10,
          },
        }],
      },
      {
        kind: 'tool_calls',
        calls: [{
          tool: 'tag_coverage',
          input: {
            tags: [
              { tag: 'time-travel', category: 'trope' },
              { tag: 'chosen-one', category: 'trope' },
            ],
            bookIds: ['fx-10', 'fx-13', 'fx-14'],
          },
        }],
      },
      {
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'fx-13', reason: 'Political space opera; coverage was checked.' }] },
      },
    ]);

    expect(result.outcome.status).toBe('answered');
    expect(actionTools(result.sink)).toEqual(['search_semantic', 'tag_coverage']);
    expect(result.creator.requests[1]?.user).not.toContain('"id":"fx-07"');
    expect(result.outcome.answer?.recommendations[0]?.bookId).toBe('fx-13');
  });
});
