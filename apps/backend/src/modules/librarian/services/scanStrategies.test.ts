import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScanStrategy, ScanProgress } from './scanStrategies';
import fs from 'fs';
import path from 'path';

describe('ScanStrategy', () => {
  let strategy: ScanStrategy;

  beforeEach(() => {
    strategy = new ScanStrategy('/tmp/test_progress.json');
    vi.restoreAllMocks();
  });

  describe('orderDirectories', () => {
    const dirs = ['/mock/dir_z', '/mock/dir_a', '/mock/dir_c'];

    beforeEach(() => {
      vi.spyOn(fs.promises, 'stat').mockResolvedValue({
        isDirectory: () => true,
        mtimeMs: 1000
      } as any);
    });

    it('should sort alphabetically', async () => {
      const ordered = await strategy.orderDirectories(dirs, 'alphabetical');
      expect(ordered).toEqual(['/mock/dir_a', '/mock/dir_c', '/mock/dir_z']);
    });

    it('should sort reverse alphabetically', async () => {
      const ordered = await strategy.orderDirectories(dirs, 'reverse');
      expect(ordered).toEqual(['/mock/dir_z', '/mock/dir_c', '/mock/dir_a']);
    });

    it('should split into quarters', async () => {
      const manyDirs = ['/d1', '/d2', '/d3', '/d4', '/d5'];
      const ordered = await strategy.orderDirectories(manyDirs, 'quarters');
      // 5 / 4 = 1, remainder 1. First part size = 2.
      expect(ordered.length).toBe(2);
      expect(ordered).toEqual(['/d1', '/d2']); // assuming alphabetical sort before split
    });

    it('should resume from specified directory', async () => {
      const ordered = await strategy.orderDirectories(dirs, 'alphabetical', 'dir_c');
      // alphabetical is a, c, z. Resuming from c means [c, z]
      expect(ordered).toEqual(['/mock/dir_c', '/mock/dir_z']);
    });
  });

  describe('progress management', () => {
    it('should save and load progress', async () => {
      const prog: ScanProgress = {
        scan_id: 'scan_123',
        total_directories: 10,
        completed_directories: 5,
        current_directory: '/mock/current',
        scan_order: 'alphabetical',
        start_time: 0,
        last_update_time: 0,
        books_found: 2,
        directories_processed: [],
        errors_encountered: [],
        resume_point: null,
        remaining_directories: []
      };

      vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
      
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify(prog));

      const saved = await strategy.saveProgress(prog);
      expect(saved).toBe(true);

      const loaded = await strategy.loadProgress();
      expect(loaded?.scan_id).toBe('scan_123');
      expect(loaded?.completed_directories).toBe(5);
    });
  });
});
