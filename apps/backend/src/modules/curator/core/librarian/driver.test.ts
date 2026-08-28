import { describe, expect, it } from 'vitest';

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

  it('rejects a shelf id that no tool returned in this conversation', async () => {
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

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).rejects.toMatchObject({
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

    await expect(driver.next({ transcript: [], round: 1, forceAnswer: false })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
      detail: { bookIds: ['prior-book'] },
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
