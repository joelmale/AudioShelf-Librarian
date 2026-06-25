import { describe, it, expect } from 'vitest';
import { BookSchema, OrganizationActionSchema } from '@audioshelf/shared/src/models';

describe('Librarian Models Validation', () => {
  it('should validate a basic book and apply defaults', () => {
    const rawData = {
      title: 'The Great Gatsby',
      source_path: '/tmp/gatsby',
      // Testing missing authors to verify default ["Unknown Author"]
    };

    const book = BookSchema.parse(rawData);

    expect(book.title).toBe('The Great Gatsby');
    expect(book.authors).toEqual(['Unknown Author']);
    expect(book.metadata_source).toBe('filename');
    expect(book.confidence_score).toBe(0);
    expect(book.is_series).toBe(false);
    expect(book.needs_processing).toBe(true);
    expect(book.audio_files).toEqual([]);
  });

  it('should reject invalid confidence scores', () => {
    const rawData = {
      title: 'The Great Gatsby',
      source_path: '/tmp/gatsby',
      confidence_score: 1.5 // Invalid, max is 1
    };

    const result = BookSchema.safeParse(rawData);
    expect(result.success).toBe(false);
  });
  
  it('should validate a full OrganizationAction', () => {
    const book = BookSchema.parse({ title: 'Test', source_path: '/src' });
    
    const action = OrganizationActionSchema.parse({
      book,
      action_type: 'move',
      source_path: '/src',
      target_path: '/dest',
      reason: 'Standardizing'
    });
    
    expect(action.executed).toBe(false);
    expect(action.success).toBe(false);
    expect(action.action_type).toBe('move');
  });
});
