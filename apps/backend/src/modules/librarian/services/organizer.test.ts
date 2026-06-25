import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { AudiobookOrganizer } from './organizer';
import type { Book, Config } from '@audioshelf/shared';

const mockConfig: Config = {
  ABS_URL: "http://localhost",
  ABS_TOKEN: "token",
  LIBRARY_DIR: "/mock/library",
  PORT: 3050
};

describe('AudiobookOrganizer', () => {
  const organizer = new AudiobookOrganizer(mockConfig);

  describe('cleanDirectoryName', () => {
    it('should replace invalid characters with safe equivalents', () => {
      expect(organizer.cleanDirectoryName('Title: Subtitle')).toBe('Title - Subtitle');
      expect(organizer.cleanDirectoryName('What? Yes!')).toBe('What Yes!');
      expect(organizer.cleanDirectoryName('The "Best" Book')).toBe("The 'Best' Book");
      expect(organizer.cleanDirectoryName('Folder/Path\\Name')).toBe('FolderPathName');
    });

    it('should strip trailing punctuation', () => {
      expect(organizer.cleanDirectoryName('Title...')).toBe('Title');
      expect(organizer.cleanDirectoryName('Title---')).toBe('Title');
      expect(organizer.cleanDirectoryName('-Title_')).toBe('Title');
    });

    it('should handle empty or entirely invalid names', () => {
      expect(organizer.cleanDirectoryName('')).toBe('Unknown');
      expect(organizer.cleanDirectoryName('?<>|')).toBe('()');
    });
  });

  describe('generateTargetPath', () => {
    it('should generate standalone path correctly', () => {
      const book: Book = {
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
        source_path: '/tmp/phm',
        audio_files: [],
        metadata_source: 'filename',
        confidence_score: 1,
        is_series: false,
        needs_processing: true
      };

      const target = organizer.generateTargetPath(book);
      expect(target).toBe(path.join('/mock/library', 'Andy Weir', 'Project Hail Mary'));
    });

    it('should generate series path correctly', () => {
      const book: Book = {
        title: 'Leviathan Wakes',
        authors: ['James S.A. Corey'],
        series: 'The Expanse',
        series_number: 1.0,
        source_path: '/tmp/expanse1',
        audio_files: [],
        metadata_source: 'filename',
        confidence_score: 1,
        is_series: true,
        needs_processing: true
      };

      const target = organizer.generateTargetPath(book);
      expect(target).toBe(path.join('/mock/library', 'James S.A. Corey', 'The Expanse', 'The Expanse - 1'));
    });
    
    it('should handle decimal series numbers correctly', () => {
      const book: Book = {
        title: 'The Churn',
        authors: ['James S.A. Corey'],
        series: 'The Expanse',
        series_number: 3.5,
        source_path: '/tmp/churn',
        audio_files: [],
        metadata_source: 'filename',
        confidence_score: 1,
        is_series: true,
        needs_processing: true
      };

      const target = organizer.generateTargetPath(book);
      expect(target).toBe(path.join('/mock/library', 'James S.A. Corey', 'The Expanse', 'The Expanse - 3.5'));
    });
  });

  describe('organizeBook action generation', () => {
    it('should return skip action if path is already correct', () => {
      const book: Book = {
        title: 'Standalone',
        authors: ['Author'],
        source_path: path.join('/mock/library', 'Author', 'Standalone'),
        audio_files: [],
        metadata_source: 'filename',
        confidence_score: 1,
        is_series: false,
        needs_processing: true
      };

      const action = organizer.organizeBook(book);
      expect(action.action_type).toBe('skip');
    });

    it('should return rename action if parent dir matches', () => {
      const book: Book = {
        title: 'Standalone',
        authors: ['Author'],
        source_path: path.join('/mock/library', 'Author', 'Wrong Title Name'),
        audio_files: [],
        metadata_source: 'filename',
        confidence_score: 1,
        is_series: false,
        needs_processing: true
      };

      // We spy on fs.existsSync so it returns false (no collision)
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const action = organizer.organizeBook(book);
      expect(action.action_type).toBe('rename');
      
      vi.restoreAllMocks();
    });
  });
});
