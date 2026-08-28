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
