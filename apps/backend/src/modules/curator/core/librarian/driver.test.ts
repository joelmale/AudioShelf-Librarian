import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { MessageCreator, MessageRequest, RawCompletion } from '../llmClient.js';
import { createPromptTurnDriver } from './driver.js';

class ScriptedCreator implements MessageCreator {
  readonly requests: MessageRequest[] = [];

  constructor(private readonly completions: RawCompletion[]) {}

  async create(request: MessageRequest): Promise<RawCompletion> {
    this.requests.push(request);
    const completion = this.completions.shift();
    if (!completion) throw new Error('ScriptedCreator ran out of completions');
    return completion;
  }

  createStream(): AsyncIterableIterator<string> {
    throw new Error('The prompt turn driver must not use streaming creation');
  }
}

const usage = { inputTokens: 17, outputTokens: 9 };

type SchemaNode = {
  $ref?: string;
  const?: string;
  type?: string;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  exclusiveMinimum?: number;
  anyOf?: SchemaNode[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

describe('createPromptTurnDriver', () => {
  it('uses the existing single-shot creator and carries the question and transcript into each round', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'tool_calls',
          calls: [{ tool: 'search_semantic', input: { query: 'rainy coastal mystery', limit: 5 } }],
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({
      creator,
      model: 'test-model',
      question: 'Something atmospheric for a rainy drive',
    });
    const transcript = [
      {
        round: 1,
        decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
        toolResults: [{ tool: 'search_library', input: {}, result: { total: 1 } }],
      },
    ];

    const decision = await driver.next({ transcript, round: 2, forceAnswer: false });

    expect(decision).toEqual({
      kind: 'tool_calls',
      calls: [{ tool: 'search_semantic', input: { query: 'rainy coastal mystery', limit: 5 } }],
      usage,
    });
    expect(creator.requests).toHaveLength(1);
    expect(creator.requests[0]?.model).toBe('test-model');
    expect(creator.requests[0]?.responseSchema).toBeDefined();
    expect(creator.requests[0]?.system).toContain('Available tools:');
    expect(creator.requests[0]?.system).toContain('search_semantic');
    expect(creator.requests[0]?.system).toContain('relaxableTags');
    expect(creator.requests[0]?.system).toContain('allTags only for an explicit absolute');
    expect(creator.requests[0]?.system).toContain('tool-owned retry');
    expect(creator.requests[0]?.system).not.toContain('lookup_external');
    expect(creator.requests[0]?.user).toContain('Something atmospheric for a rainy drive');
    expect(creator.requests[0]?.user).toContain('search_library');
  });

  it('returns an owned-shelf answer and preserves measured usage exactly', async () => {
    const creator = new ScriptedCreator([
      {
        text: '```json\n{"kind":"answer","answer":{"recommendations":[{"bookId":"b-1","title":"A hallucinated rename","reason":"Coastal and reflective."}]}}\n```',
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'A coastal mood' });

    const transcript = [{
      round: 1,
      decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      toolResults: [{
        tool: 'search_library',
        input: {},
        result: { books: [{ id: 'b-1', title: 'Harbor Fog', author: 'M. Shore' }] },
      }],
    }];

    await expect(driver.next({ transcript, round: 2, forceAnswer: false })).resolves.toEqual({
      kind: 'answer',
      answer: {
        recommendations: [{ bookId: 'b-1', title: 'Harbor Fog', author: 'M. Shore', reason: 'Coastal and reflective.' }],
      },
      usage,
    });
  });

  it('hydrates card-parity fields from the retrieved card and the ranker, never from the model', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: {
            recommendations: [
              { bookId: 'ranked', reason: 'Ranked semantically.' },
              { bookId: 'plain', reason: 'Found by structured search.' },
            ],
          },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'A coastal mood' });

    const transcript = [{
      round: 1,
      decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      toolResults: [
        {
          tool: 'search_semantic',
          input: {},
          result: {
            results: [{
              book: { id: 'ranked', title: 'Harbor Fog', author: 'M. Shore', durationSeconds: 28_800 },
              matchedTags: ['mood: reflective', 'setting: coastal'],
            }],
          },
        },
        {
          // No ranker ran, so there is no match set to report. Absent, not [].
          tool: 'search_library',
          input: {},
          result: { books: [{ id: 'plain', title: 'Tide Tables', author: null, durationSeconds: null }] },
        },
      ],
    }];

    const decision = await driver.next({ transcript, round: 2, forceAnswer: false });

    expect(decision).toEqual({
      kind: 'answer',
      answer: {
        recommendations: [
          {
            bookId: 'ranked',
            title: 'Harbor Fog',
            author: 'M. Shore',
            reason: 'Ranked semantically.',
            durationSeconds: 28_800,
            matchedTags: ['mood: reflective', 'setting: coastal'],
          },
          { bookId: 'plain', title: 'Tide Tables', reason: 'Found by structured search.' },
        ],
      },
      usage,
    });
  });

  it('keeps a ranker match set when a later non-ranking retrieval touches the same book', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'ranked', reason: 'Still the semantic hit.' }] },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'A coastal mood' });

    const decision = await driver.next({
      transcript: [
        {
          round: 1,
          decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
          toolResults: [{
            tool: 'search_semantic',
            input: {},
            result: { results: [{ book: { id: 'ranked', title: 'Harbor Fog', author: null, durationSeconds: 100 }, matchedTags: ['mood: bleak'] }] },
          }],
        },
        {
          // The seed block tells the model to do exactly this. `get_book`
          // reports no match set; it must not blank the one already reported.
          round: 2,
          decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
          toolResults: [{
            tool: 'get_book',
            input: {},
            result: { book: { id: 'ranked', title: 'Harbor Fog', author: null, durationSeconds: 100 } },
          }],
        },
      ],
      round: 3,
      forceAnswer: false,
    });

    expect(decision).toMatchObject({
      answer: { recommendations: [{ bookId: 'ranked', matchedTags: ['mood: bleak'], durationSeconds: 100 }] },
    });
  });

  it('ignores card fields the model authored for itself', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: {
            recommendations: [{
              bookId: 'b-1',
              reason: 'Coastal.',
              // Neither of these may reach the answer: display fields come
              // from the retrieved card, never from model prose.
              matchedTags: ['fabricated: award-winning'],
              durationSeconds: 999_999,
            }],
          },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'A coastal mood' });

    const decision = await driver.next({
      transcript: [{
        round: 1,
        decision: { kind: 'tool_calls' as const, calls: [], usage: { inputTokens: 1, outputTokens: 1 } },
        toolResults: [{ tool: 'search_library', input: {}, result: { books: [{ id: 'b-1', title: 'Harbor Fog', author: null, durationSeconds: 100 }] } }],
      }],
      round: 2,
      forceAnswer: false,
    });

    expect(decision).toEqual({
      kind: 'answer',
      answer: { recommendations: [{ bookId: 'b-1', title: 'Harbor Fog', reason: 'Coastal.', durationSeconds: 100 }] },
      usage,
    });
  });

  it('sends picked shelf seeds as resolved anchors that are not retrieval evidence', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'seed-1', reason: 'You picked it.' }] },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({
      creator,
      model: 'test-model',
      question: 'More like these',
      seeds: [{ bookId: 'seed-1', title: 'Harbor Fog', author: 'M. Shore' }],
    });

    const decision = await driver.next({ transcript: [], round: 1, forceAnswer: false });

    const prompt = creator.requests[0]?.user ?? '';
    expect(prompt).toContain('"bookId":"seed-1"');
    expect(prompt).toContain('Harbor Fog');
    // A seed is a pointer, not evidence: with nothing retrieved, the answer
    // must come back empty rather than recommending the anchor itself.
    expect(decision).toMatchObject({ kind: 'answer', answer: { recommendations: [] } });
  });

  it('structurally rejects another tool call on the forced-answer round', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool: 'search_library', input: {} }] }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Choose one' });

    await expect(driver.next({ transcript: [], round: 6, forceAnswer: true })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
    expect(creator.requests[0]?.user).toContain('MUST answer now');
  });

  it('rejects external-only recommendations because v1 is library-only', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ title: 'A Book We Do Not Own', author: 'Someone', reason: 'Maybe.' }] },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Surprise me' });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('returns a clean empty answer when the model invents a shelf id with zero current-turn evidence', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'invented-id', reason: 'It sounds plausible.' }] },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Surprise me' });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).resolves.toMatchObject({
      kind: 'answer',
      answer: { recommendations: [] },
    });
  });

  it.each([
    ['title', { title: { value: 'wrong' } }],
    ['author', { author: { value: 'wrong' } }],
    ['tag', { tag: { value: 'wrong' } }],
    ['category', { category: { value: 'wrong' } }],
  ] as const)('rejects malformed search_library %s input instead of accepting unknown records', async (_field, input) => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({
        kind: 'tool_calls',
        calls: [{ tool: 'search_library', input }],
      }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Find a book' });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it.each([
    ['search_library', { title: 'The Long Way', category: 'genre' }],
    ['get_book', { id: 'b-1' }],
    ['find_similar', { bookId: 'b-1', k: 3, acrossGenre: true }],
    ['search_semantic', { query: 'quiet and strange', relaxableTags: [{ tag: 'mystery', category: 'genre' }] }],
    ['tag_coverage', { tags: [{ tag: 'mystery', category: 'genre', minConfidence: 0.5 }], bookIds: ['b-1'] }],
  ] as const)('accepts the concrete %s registry input shape', async (tool, input) => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool, input }] }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Find a book' });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).resolves.toMatchObject({ kind: 'tool_calls' });
  });

  it('retains search_library cross-field refinement at runtime', async () => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool: 'search_library', input: { minDurationHours: 10, maxDurationHours: 9 } }] }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Find a book' });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('publishes all registry tool branches and concrete search_library fields to providers', async () => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool: 'get_book', input: { id: 'b-1' } }] }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Find a book' });
    await driver.next({ transcript: [], round: 1, forceAnswer: false });

    const schema = zodToJsonSchema(creator.requests[0]?.responseSchema as Parameters<typeof zodToJsonSchema>[0]) as {
      anyOf?: Array<{ properties?: Record<string, SchemaNode> }>;
    };
    const toolCallsSchema = schema.anyOf?.[0]?.properties?.calls?.items;
    const branches = (toolCallsSchema?.anyOf ?? []) as Array<{ properties?: Record<string, SchemaNode> }>;
    const branch = (tool: string): SchemaNode => {
      const found = branches.find((candidate) => candidate.properties?.tool?.const === tool);
      expect(found).toBeDefined();
      return found?.properties?.input ?? {};
    };
    expect(branch('search_library').properties?.title).toMatchObject({ type: 'string', minLength: 1 });
    expect(branch('get_book').properties?.id).toMatchObject({ type: 'string', minLength: 1 });
    expect(branch('find_similar').properties?.bookId?.$ref).toContain('id');
    expect(branch('find_similar').properties?.k?.$ref).toContain('limit');
    expect(branch('search_semantic').properties?.query).toMatchObject({ type: 'string', minLength: 1 });
    expect(branch('search_semantic').properties?.relaxableTags).toMatchObject({ type: 'array', maxItems: 50 });
    expect(branch('tag_coverage').properties?.tags).toMatchObject({ type: 'array', minItems: 1, maxItems: 50 });
    expect(branch('tag_coverage').properties?.tags?.items).toMatchObject({ type: 'object' });
  });

  it('still rejects every unsupported id when current-turn evidence exists', async () => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'invented-id', reason: 'Nope.' }] },
      }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Surprise me' });
    const transcript = [{
      round: 1,
      decision: { kind: 'tool_calls' as const, calls: [], usage },
      toolResults: [{
        tool: 'search_semantic',
        input: { query: 'surprise' },
        result: { results: [{ book: { id: 'real', title: 'Real', author: null } }] },
      }],
    }];

    await expect(driver.next({ transcript, round: 2, forceAnswer: false })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
      detail: { bookIds: ['invented-id'] },
    });
  });

  it('replaces a reason that describes a different book in the same slate', async () => {
    // The guard shipped on the Scout path first; unifying the surfaces onto
    // this one would have routed straight around it, so it is asserted here
    // against the exact shape observed on the real library.
    const creator = new ScriptedCreator([{
      text: JSON.stringify({
        kind: 'answer',
        answer: {
          recommendations: [{
            bookId: 'straits',
            reason: '‘Sunburn’ is another novel from Laurence Shames set in Key West.',
          }],
        },
      }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'beach mystery' });
    const transcript = [{
      round: 1,
      decision: { kind: 'tool_calls' as const, calls: [], usage },
      toolResults: [{
        tool: 'search_semantic',
        input: { query: 'beach mystery' },
        result: {
          results: [
            { book: { id: 'straits', title: 'Florida Straits', author: 'Laurence Shames' }, matchedTags: ['crime-fiction', 'key-west'] },
            { book: { id: 'sunburn', title: 'Sunburn: Key West, Book 03', author: 'Laurence Shames' }, matchedTags: ['noir'] },
          ],
        },
      }],
    }];

    const decision = await driver.next({ transcript, round: 2, forceAnswer: false });

    expect(decision.kind).toBe('answer');
    const [recommendation] = (decision as { answer: { recommendations: Array<Record<string, unknown>> } }).answer.recommendations;
    expect(recommendation?.reasonReplaced).toBe(true);
    expect(recommendation?.reason).not.toContain('Sunburn');
    expect(recommendation?.reason).toContain('crime-fiction');
  });

  it('leaves a correct reason untouched and does not mark it replaced', async () => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'straits', reason: 'A sunny Key West caper with a wry tone.' }] },
      }),
      usage,
    }]);
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'beach mystery' });
    const transcript = [{
      round: 1,
      decision: { kind: 'tool_calls' as const, calls: [], usage },
      toolResults: [{
        tool: 'search_semantic',
        input: { query: 'beach mystery' },
        result: {
          results: [
            { book: { id: 'straits', title: 'Florida Straits', author: 'Laurence Shames' }, matchedTags: ['crime-fiction'] },
            { book: { id: 'sunburn', title: 'Sunburn: Key West, Book 03', author: 'Laurence Shames' }, matchedTags: [] },
          ],
        },
      }],
    }];

    const decision = await driver.next({ transcript, round: 2, forceAnswer: false });
    const [recommendation] = (decision as { answer: { recommendations: Array<Record<string, unknown>> } }).answer.recommendations;
    expect(recommendation?.reason).toBe('A sunny Key West caper with a wry tone.');
    expect(recommendation?.reasonReplaced).toBeUndefined();
  });

  it('uses prior answer prose as context but never as current-turn evidence', async () => {
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'prior-book', reason: 'Reuse the earlier pick.' }] },
        }),
        usage,
      },
    ]);
    const driver = createPromptTurnDriver({
      creator,
      model: 'test-model',
      question: 'What about something shorter?',
      history: [{ question: 'A coastal mystery', answer: '[{"title":"Harbor Fog","reason":"Moody."}]' }],
    });

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).resolves.toMatchObject({
      kind: 'answer',
      answer: { recommendations: [] },
    });
    expect(creator.requests[0]?.user).toContain('A coastal mystery');
    expect(creator.requests[0]?.user).toContain('Harbor Fog');
    expect(creator.requests[0]?.user).toContain('NOT current evidence');
    expect(creator.requests[0]?.user).toContain('Prior transcript (oldest first):\n[]');
  });

  it('bounds prior conversation context by both turn count and serialized size', async () => {
    const creator = new ScriptedCreator([{
      text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool: 'search_library', input: {} }] }),
      usage,
    }]);
    const history = Array.from({ length: 10 }, (_, index) => ({
      question: `question-${index}`,
      answer: index === 9 ? '\\'.repeat(7_000) : `answer-${index}`,
    }));
    const driver = createPromptTurnDriver({ creator, model: 'test-model', question: 'Continue', history });

    await driver.next({ transcript: [], round: 1, forceAnswer: false });

    const prompt = creator.requests[0]?.user ?? '';
    expect(prompt).not.toContain('question-0');
    expect(prompt).not.toContain('question-1');
    expect(prompt).not.toContain('question-9');
    expect(prompt).toContain('question-8');
    expect(prompt.length).toBeLessThan(14_000);
  });
});
