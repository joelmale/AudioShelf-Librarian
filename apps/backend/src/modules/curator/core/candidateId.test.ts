import { describe, expect, it } from 'vitest';
import { generateCandidateId } from './candidateId.js';

describe('generateCandidateId', () => {
  it('generates deterministic IDs from source and native ID', () => {
    const id1 = generateCandidateId('audible', 'B08G9W2925');
    const id2 = generateCandidateId('audible', 'B08G9W2925');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cand_audible_[a-f0-9]{16}$/);
  });

  it('keeps sources distinct for the same native ID or title', () => {
    const audibleId = generateCandidateId('audible', '12345');
    const appleId = generateCandidateId('apple', '12345');
    expect(audibleId).not.toBe(appleId);
    expect(audibleId.startsWith('cand_audible_')).toBe(true);
    expect(appleId.startsWith('cand_apple_')).toBe(true);
  });

  it('falls back to title and author when native ID is absent', () => {
    const id = generateCandidateId('nyt-fiction', null, 'The Women', 'Kristin Hannah');
    const idRepeat = generateCandidateId('nyt-fiction', undefined, 'The Women', 'Kristin Hannah');
    expect(id).toBe(idRepeat);
    expect(id).toMatch(/^cand_nyt-fiction_[a-f0-9]{16}$/);
  });

  it('handles non-Latin titles and punctuation safely', () => {
    const id1 = generateCandidateId('audible', null, '三体 (The Three-Body Problem)', '刘慈欣 (Cixin Liu)');
    const id2 = generateCandidateId('audible', null, '三体 (The Three-Body Problem)', '刘慈欣 (Cixin Liu)');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cand_audible_[a-f0-9]{16}$/);
  });
});
