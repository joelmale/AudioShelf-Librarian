/**
 * CLI: import OCLC FAST alt-labels as `tag_aliases` rows for terms already in
 * our vocabulary (librarian engine plan §2, "Offline datasets").
 *
 * All parsing/import logic — and its tests — live in
 * `apps/backend/src/modules/curator/core/tagging/fastImport.ts` (scripts/
 * sits outside the vitest workspaces, so nothing here is unit-tested). This
 * file is a thin I/O shell: stream the `.nt`/`.nt.gz` dump line-by-line,
 * batch lines through that module so memory stays flat regardless of dump
 * size, and print a summary. It never runs raw SQL — CuratorDb is the only
 * way this touches the database.
 *
 * Usage:
 *   npm run load:fast -- --file FASTTopical.nt.gz --db /app/data/curator.db --category theme
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import { CuratorDb } from '../apps/backend/src/modules/curator/core/db.js';
import {
  importFastAliases,
  parseFastNTriples,
} from '../apps/backend/src/modules/curator/core/tagging/fastImport.js';
import { TAG_CATEGORIES, type TagCategory } from '../apps/backend/src/modules/curator/core/types.js';

/** Lines batched through parseFastNTriples/importFastAliases at a time, so a
 * 1.7M-triple dump never materializes as one giant in-memory array. */
const BATCH_SIZE = 50_000;

interface Args {
  file: string;
  db: string;
  category: TagCategory;
}

function readFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
}

function parseArgs(argv: string[]): Args {
  const file = readFlag(argv, '--file');
  const db = readFlag(argv, '--db');
  const categoryRaw = readFlag(argv, '--category') ?? 'theme';

  if (!file) throw new Error('Missing required --file <path.nt or .nt.gz>');
  if (!db) throw new Error('Missing required --db <path to curator.db>');
  if (!(TAG_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    throw new Error(`Invalid --category "${categoryRaw}". Must be one of: ${TAG_CATEGORIES.join(', ')}`);
  }

  return { file, db, category: categoryRaw as TagCategory };
}

async function loadFast(args: Args): Promise<void> {
  const db = new CuratorDb(args.db);
  try {
    const rawStream = createReadStream(args.file);
    const lineSource = args.file.endsWith('.gz') ? rawStream.pipe(createGunzip()) : rawStream;
    const rl = createInterface({ input: lineSource, crlfDelay: Infinity });

    let linesSeen = 0;
    let entriesSeen = 0;
    let matched = 0;
    let aliasesAdded = 0;
    let batch: string[] = [];

    const flush = (): void => {
      if (batch.length === 0) return;
      const entries = parseFastNTriples(batch);
      entriesSeen += entries.length;
      const result = importFastAliases(db, entries, args.category);
      matched += result.matched;
      aliasesAdded += result.aliasesAdded;
      batch = [];
    };

    for await (const line of rl) {
      batch.push(line);
      linesSeen++;
      if (batch.length >= BATCH_SIZE) flush();
    }
    flush();

    console.log('FAST alias import complete.');
    console.log(`  Category:       ${args.category}`);
    console.log(`  Lines read:     ${linesSeen}`);
    console.log(`  Entries parsed: ${entriesSeen}`);
    console.log(`  Vocab matches:  ${matched}`);
    console.log(`  Aliases added:  ${aliasesAdded}`);
  } finally {
    db.close();
  }
}

parseAndRun();

function parseAndRun(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(`Loading FAST aliases from ${args.file} into ${args.db} (category=${args.category})`);
  loadFast(args).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
