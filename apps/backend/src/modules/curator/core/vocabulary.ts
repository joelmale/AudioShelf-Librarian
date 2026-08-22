/**
 * Curated seed vocabulary for the tag taxonomy (librarian engine plan §1.4).
 *
 * This used to live as `VOCABULARY` inside `tagQuality.ts`, used only to warn
 * on out-of-vocabulary tags. It now doubles as the seed data for the
 * `vocab_terms` table (`CuratorDb` inserts each of these as `status='seed'`
 * on every startup, idempotently) — the live promotion queue in `db.ts`
 * builds on top of these rows.
 *
 * Arrays, not Sets: this is seed data to iterate and insert, not a
 * membership-check structure (that's built at the call site instead).
 */
import type { TagCategory } from './types.js';

export const SEED_VOCABULARY: Record<TagCategory, readonly string[]> = {
  genre: [
    'hard-sci-fi',
    'space-opera',
    'cyberpunk',
    'dystopian',
    'military-sci-fi',
    'fantasy',
    'thriller',
  ],
  mood: ['dark', 'humorous', 'hopeful', 'tense', 'meditative', 'action-driven'],
  theme: ['first-contact', 'ai', 'time-travel', 'post-apocalyptic', 'political', 'survival', 'dystopian'],
  era: ['golden-age', 'new-wave', 'modern', 'classic'],
  pacing: ['slow-burn', 'fast-paced', 'episodic', 'dense'],
  length: ['short', 'medium', 'long', 'epic'],
  audience: ['adult', 'ya', 'all-ages'],
  trope: [
    'chosen-one',
    'love-triangle',
    'found-family',
    'enemies-to-lovers',
    'unreliable-narrator',
    'redemption-arc',
    'heist',
    'anti-hero',
    'hard-magic',
    'soft-magic',
    'fish-out-of-water',
    'deus-ex-machina',
  ],
  structure: [
    'linear',
    'nonlinear',
    'multi-pov',
    'single-pov',
    'epistolary',
    'frame-story',
    'dual-timeline',
    'anthology',
  ],
  // Open categories: characters and settings are grounded against a book's
  // entity allowlist (core/tagging/ground.ts) rather than a fixed vocabulary,
  // so there is no seed data here.
  character: [],
  setting: [],
};
