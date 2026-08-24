import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from '../embeddings.js';
import { createStubEmbeddingCreator, stubEmbed, STUB_EMBEDDING_DIM } from './stubEmbedder.js';

describe('stubEmbed', () => {
  it('is deterministic: the same text produces element-wise identical vectors', () => {
    const a = stubEmbed('x y z');
    const b = stubEmbed('x y z');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('L2-normalizes a non-empty result to a unit vector', () => {
    const vec = stubEmbed('melancholic coastal autumn');
    let normSq = 0;
    for (const v of vec) normSq += v * v;
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 5);
  });

  it('semantic sanity: cosine tracks token overlap', () => {
    const query = stubEmbed('melancholic coastal autumn');
    const allThree = stubEmbed('a melancholic story set on a coastal autumn evening');
    const oneWord = stubEmbed('a fast-paced coastal heist thriller');
    const none = stubEmbed('robots fighting in outer space');

    const scoreAllThree = cosineSimilarity(query, allThree);
    const scoreOneWord = cosineSimilarity(query, oneWord);
    const scoreNone = cosineSimilarity(query, none);

    expect(scoreAllThree).toBeGreaterThan(scoreOneWord);
    expect(scoreOneWord).toBeGreaterThan(scoreNone);
  });

  it('tokenizes hyphenated compounds so a substring token still matches', () => {
    const a = stubEmbed('coastal-town');
    const b = stubEmbed('coastal');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0);
  });

  it('returns an all-zero vector for empty / punctuation-only text, and cosine against it is 0 (no NaN)', () => {
    const empty = stubEmbed('');
    const punct = stubEmbed('... --- !!!');
    expect(Array.from(empty)).toEqual(new Array(STUB_EMBEDDING_DIM).fill(0));
    expect(Array.from(punct)).toEqual(new Array(STUB_EMBEDDING_DIM).fill(0));

    const other = stubEmbed('melancholic coastal autumn');
    expect(cosineSimilarity(empty, other)).toBe(0);
    expect(Number.isNaN(cosineSimilarity(empty, other))).toBe(false);
  });

  it('every element is exactly float32 (round-trips through Math.fround)', () => {
    const vec = stubEmbed('melancholic coastal autumn evening story');
    for (const v of vec) {
      expect(v).toBe(Math.fround(v));
    }
  });
});

describe('createStubEmbeddingCreator', () => {
  it('returns one vector per input, in order', async () => {
    const creator = createStubEmbeddingCreator();
    const result = await creator.create({
      model: 'anything',
      input: ['melancholic coastal autumn', 'robots fighting in outer space'],
    });

    expect(result).toHaveLength(2);
    expect(Array.from(result[0]!)).toEqual(Array.from(stubEmbed('melancholic coastal autumn')));
    expect(Array.from(result[1]!)).toEqual(Array.from(stubEmbed('robots fighting in outer space')));
  });

  it('returns [] for empty input', async () => {
    const creator = createStubEmbeddingCreator();
    const result = await creator.create({ model: 'anything', input: [] });
    expect(result).toEqual([]);
  });

  it('ignores req.model and never rejects', async () => {
    const creator = createStubEmbeddingCreator();
    await expect(creator.create({ model: 'whatever-model', input: ['hello world'] })).resolves.toBeDefined();
  });
});
