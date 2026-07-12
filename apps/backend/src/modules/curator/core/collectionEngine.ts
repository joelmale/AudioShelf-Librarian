/**
 * Collection proposal + push logic.
 *
 * Deterministic templates are pure SQL (no Claude); the `custom` template uses
 * Claude over a compact tag summary. Push reconciles with ABS using a conflict
 * policy and is idempotent.
 *
 * Adversarial set (MADP-FULL):
 *  - B4: name conflict on push honors the policy (skip/overwrite/rename) and
 *    never silently creates a duplicate.
 *  - A3: Claude-returned book ids that don't exist locally are dropped, never
 *    persisted or pushed (hallucination guard).
 *  - C2/C3: re-push updates our existing ABS collection rather than duplicating;
 *    collection_books inserts are FK-checked against books.
 *  - B5: empty proposals are handled (push of an empty collection is refused).
 *  - D1–D3: typed errors throughout; nothing swallowed.
 */
import type { ABSClient } from './absClient.js';
import type { LlmClient } from './llmClient.js';
import type { CuratorDb } from './db.js';
import { ABSRequestError, ConflictError, NotFoundError, toAppError } from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import type { OperationController } from './operations.js';
import {
  type Book,
  type Collection,
  type ConflictPolicy,
  type PushResult,
  type TagCategory,
  type TagSummary,
  type TagSummaryBook,
  type TokenUsage,
} from './types.js';

type OrderStrategy = 'sequence' | 'year' | 'duration' | 'title';

interface TemplateDef {
  id: string;
  name: string;
  description: string;
  usesClaude: boolean;
  order: OrderStrategy;
  select?: (db: CuratorDb) => Book[];
}

const SUMMARY_CATEGORIES: TagCategory[] = ['genre', 'mood', 'theme', 'era', 'pacing'];

/** Built-in theme templates (deterministic unless `usesClaude`). */
export const TEMPLATES: readonly TemplateDef[] = [
  {
    id: 'quick-listens',
    name: 'Quick Listens',
    description: 'Short audiobooks under six hours.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('length', ['short'])),
  },
  {
    id: 'epic-reads',
    name: 'Epic Reads',
    description: 'Sprawling listens over twenty hours.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('length', ['epic'])),
  },
  {
    id: 'gateway-scifi',
    name: 'Gateway Sci-Fi',
    description: 'High-confidence hard sci-fi and space opera to start with.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('genre', ['hard-sci-fi', 'space-opera'], 0.8)),
  },
  {
    id: 'dark-futures',
    name: 'Dark Futures',
    description: 'Dystopian and post-apocalyptic visions.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('theme', ['dystopian', 'post-apocalyptic'])),
  },
  {
    id: 'laugh-track',
    name: 'Comedic Relief',
    description: 'Humorous, lighter listens.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('mood', ['humorous'])),
  },
  {
    id: 'first-contact',
    name: 'First Contact',
    description: 'Humanity meets the unknown.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('theme', ['first-contact'])),
  },
  {
    id: 'ai-and-robots',
    name: 'AI & Robots',
    description: 'Artificial minds and machines.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('theme', ['ai'])),
  },
  {
    id: 'golden-age',
    name: 'Golden Age Classics',
    description: 'The golden age of science fiction.',
    usesClaude: false,
    order: 'year',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('era', ['golden-age'])),
  },
  {
    id: 'time-travel',
    name: 'Time Travel',
    description: 'Journeys through time.',
    usesClaude: false,
    order: 'duration',
    select: (db) => db.getBooksByIds(db.getBookIdsByTag('theme', ['time-travel'])),
  },
  {
    id: 'series-starters',
    name: 'Start a Series',
    description: 'First entries of a series.',
    usesClaude: false,
    order: 'sequence',
    select: (db) => db.getSeriesStarters(),
  },
  {
    id: 'standalones',
    name: 'Standalone Novels',
    description: 'Self-contained, no series commitment.',
    usesClaude: false,
    order: 'title',
    select: (db) => db.getStandalones(),
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Describe a theme in natural language; Claude curates it.',
    usesClaude: true,
    order: 'duration',
  },
];

export interface GenerateResult {
  collection: Collection;
  books: Book[];
  droppedBookIds?: string[];
  usage?: TokenUsage;
}

const nullableNumber = (n: number | null): number => (n === null ? Number.POSITIVE_INFINITY : n);

/** Order books for a collection per the strategy (Task 3.4); nulls sort last. */
export function orderBooks(books: Book[], strategy: OrderStrategy): Book[] {
  const sorted = [...books];
  switch (strategy) {
    case 'sequence':
      sorted.sort((a, b) => nullableNumber(a.seriesSequence) - nullableNumber(b.seriesSequence) || a.title.localeCompare(b.title));
      break;
    case 'year':
      sorted.sort((a, b) => nullableNumber(a.publishedYear) - nullableNumber(b.publishedYear) || a.title.localeCompare(b.title));
      break;
    case 'duration':
      sorted.sort((a, b) => nullableNumber(a.durationSeconds) - nullableNumber(b.durationSeconds) || a.title.localeCompare(b.title));
      break;
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
  }
  return sorted;
}

/** Compact, token-efficient representation of the library for Claude. */
export function buildTagSummary(db: CuratorDb): TagSummary {
  const books = db.getAllBooks();
  const tags = db.getAllBookTags();
  const byBook = new Map<string, Partial<Record<TagCategory, string[]>>>();
  for (const t of tags) {
    if (!SUMMARY_CATEGORIES.includes(t.category)) continue;
    let entry = byBook.get(t.bookId);
    if (!entry) {
      entry = {};
      byBook.set(t.bookId, entry);
    }
    (entry[t.category] ??= []).push(t.tag);
  }
  return books.map((b): TagSummaryBook => ({
    id: b.id,
    title: b.title,
    author: b.author,
    durationHr: b.durationSeconds === null ? null : Math.round((b.durationSeconds / 3600) * 10) / 10,
    tags: byBook.get(b.id) ?? {},
  }));
}

function persistCollection(
  db: CuratorDb,
  input: { name: string; description: string | null; theme: string; books: Book[]; now: number }
): GenerateResult {
  const id = db.insertCollection({
    name: input.name,
    description: input.description,
    theme: input.theme,
    createdAt: input.now,
  });
  db.setCollectionBooks(
    id,
    input.books.map((b, i) => ({ bookId: b.id, sortOrder: i }))
  );
  const collection = db.getCollection(id);
  if (!collection) throw new NotFoundError(`Collection ${id} vanished after insert`);
  return { collection, books: input.books };
}

export interface GenerateOptions {
  logger?: Logger;
  now?: () => number;
  controller?: OperationController;
  /**
   * When true (default), regenerating a template whose existing proposal is
   * still `proposed` updates that proposal in place instead of creating a
   * duplicate (idempotent re-generation, used by the scheduler). An already
   * approved/pushed collection is never overwritten — a fresh one is created.
   */
  replaceExisting?: boolean;
}

/** Generate a proposal from a deterministic template (pure SQL). */
export function generateFromTemplate(
  db: CuratorDb,
  templateId: string,
  options: GenerateOptions = {}
): GenerateResult {
  const now = options.now ?? Date.now;
  const replaceExisting = options.replaceExisting ?? true;
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new NotFoundError(`Unknown template: ${templateId}`);
  if (template.usesClaude || !template.select) {
    throw new ConflictError(`Template "${templateId}" requires Claude — use generateCustom`);
  }
  const books = orderBooks(template.select(db), template.order);

  if (replaceExisting) {
    const existing = db.findCollectionByTheme(templateId);
    if (existing && existing.status === 'proposed') {
      db.updateCollectionMeta(existing.id, { name: template.name, description: template.description });
      db.setCollectionBooks(
        existing.id,
        books.map((b, i) => ({ bookId: b.id, sortOrder: i }))
      );
      const updated = db.getCollection(existing.id);
      if (!updated) throw new NotFoundError(`Collection ${existing.id} vanished`);
      return { collection: updated, books };
    }
  }

  return persistCollection(db, {
    name: template.name,
    description: template.description,
    theme: templateId,
    books,
    now: now(),
  });
}

/** Generate a custom proposal via Claude, dropping any hallucinated book ids (A3). */
export async function generateCustom(
  llmClient: LlmClient,
  db: CuratorDb,
  prompt: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? nullLogger;
  if (options.controller) await options.controller.checkpoint();

  const summary = buildTagSummary(db);
  const { proposal, usage } = await llmClient.generateCollection(summary, prompt);

  // Hallucination guard: keep only ids that exist locally.
  const existing = db.existingBookIds(proposal.bookIds);
  const validIds = proposal.bookIds.filter((id) => existing.has(id));
  const droppedBookIds = proposal.bookIds.filter((id) => !existing.has(id));
  if (droppedBookIds.length > 0) {
    logger.warn('Dropped hallucinated book ids from custom collection', {
      dropped: droppedBookIds.length,
      total: proposal.bookIds.length,
    });
  }

  const books = orderBooks(db.getBooksByIds(validIds), 'duration');
  const result = persistCollection(db, {
    name: proposal.name,
    description: proposal.description || null,
    theme: `custom: ${prompt}`,
    books,
    now: now(),
  });
  result.usage = usage;
  if (droppedBookIds.length > 0) result.droppedBookIds = droppedBookIds;
  return result;
}

/** Generate multiple creative collections autonomously via Claude/Ollama. */
export async function generateAutoDiscover(
  llmClient: LlmClient,
  db: CuratorDb,
  options: GenerateOptions = {}
): Promise<GenerateResult[]> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? nullLogger;
  if (options.controller) await options.controller.checkpoint();

  const summary = buildTagSummary(db);
  const { proposals, usage } = await llmClient.autoDiscoverCollections(summary);

  const results: GenerateResult[] = [];
  for (const proposal of proposals) {
    const existing = db.existingBookIds(proposal.bookIds);
    const validIds = proposal.bookIds.filter((id) => existing.has(id));
    const droppedBookIds = proposal.bookIds.filter((id) => !existing.has(id));
    
    if (droppedBookIds.length > 0) {
      logger.warn('Dropped hallucinated book ids from auto-discover collection', {
        dropped: droppedBookIds.length,
        total: proposal.bookIds.length,
      });
    }
    
    if (validIds.length === 0) continue;

    const books = orderBooks(db.getBooksByIds(validIds), 'duration');
    const result = persistCollection(db, {
      name: proposal.name,
      description: proposal.description || null,
      theme: `autodiscover: ${proposal.reasoning || 'AI Pattern'}`,
      books,
      now: now(),
    });
    result.usage = usage;
    if (droppedBookIds.length > 0) result.droppedBookIds = droppedBookIds;
    results.push(result);
  }

  return results;
}

export interface PushOptions {
  policy?: ConflictPolicy;
  libraryId?: string;
  logger?: Logger;
  now?: () => number;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Push a collection to ABS, honoring the conflict policy. Idempotent. */
export async function pushCollection(
  absClient: ABSClient,
  db: CuratorDb,
  collectionId: number,
  options: PushOptions = {}
): Promise<PushResult> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? nullLogger;
  const policy: ConflictPolicy = options.policy ?? 'skip';

  const collection = db.getCollection(collectionId);
  if (!collection) throw new NotFoundError(`No collection ${collectionId}`);
  if (collection.status !== 'approved' && collection.status !== 'pushed') {
    throw new ConflictError(
      `Collection ${collectionId} is "${collection.status}" — only approved collections can be pushed`
    );
  }

  const books = db.getCollectionBooksDetailed(collectionId);
  const bookIds = books.map((b) => b.id);
  if (bookIds.length === 0) {
    throw new ConflictError(`Collection ${collectionId} has no books — nothing to push (B5)`);
  }

  const logId = db.startLog('push', now());
  try {
    const libraryId = options.libraryId ?? collection.libraryId ?? (await firstLibraryId(absClient));
    if(books.some(b=>b.libraryId!==libraryId)) throw new ConflictError('Collection contains books outside its target library');
    const marker=collection.ownershipMarker ?? `audioshelf:${collection.id}`;
    const managedDescription=`[Managed by AudioShelf: ${marker}]${collection.description ? `\n${collection.description}` : ''}`;
    const existing = await absClient.getCollections(libraryId);
    const existingByName = new Map(existing.map((c) => [c.name, c]));

    // Idempotent re-push: if we already pushed this collection and it still
    // exists in ABS, update it rather than creating a duplicate (C2).
    if (collection.absCollectionId && existing.some((c) => c.id === collection.absCollectionId)) {
      await absClient.updateCollection(collection.absCollectionId, bookIds, {
        name: collection.name,
        description: managedDescription,
      });
      return finish(db, logId, collection, collection.absCollectionId, 'updated', collection.name, now());
    }

    const conflict = existingByName.get(collection.name);
    if (conflict) {
      if (policy === 'skip') {
        db.finishLog(logId, 'success', { action: 'skipped', name: collection.name }, now());
        logger.info('Push skipped — name conflict', { name: collection.name });
        return { collectionId, absCollectionId: conflict.id, action: 'skipped', finalName: collection.name };
      }
      if (policy === 'overwrite') {
        throw new ConflictError('Refusing to overwrite an ABS collection not owned by AudioShelf');
      }
      // rename
      const finalName = uniqueName(collection.name, new Set(existingByName.keys()));
      const absId = await absClient.createCollection({
        libraryId,
        name: finalName,
        description: managedDescription,
        bookIds,
      });
      db.updateCollectionMeta(collectionId, { name: finalName });
      db.claimCollection(collectionId,libraryId,marker);
      return finish(db, logId, collection, absId, 'renamed', finalName, now());
    }

    // No conflict — create fresh.
    const absId = await absClient.createCollection({
      libraryId,
      name: collection.name,
      description: managedDescription,
      bookIds,
    });
    db.claimCollection(collectionId,libraryId,marker);
    return finish(db, logId, collection, absId, 'created', collection.name, now());
  } catch (err) {
    const appErr = toAppError(err);
    db.finishLog(logId, 'error', appErr.toPayload(), now());
    throw appErr;
  }
}

async function firstLibraryId(absClient: ABSClient): Promise<string> {
  const libraries = await absClient.getLibraries();
  const first = libraries[0];
  if (!first) throw new ABSRequestError(404, 'ABS has no libraries to push a collection into');
  return first.id;
}

function finish(
  db: CuratorDb,
  logId: number,
  collection: Collection,
  absCollectionId: string,
  action: PushResult['action'],
  finalName: string,
  now: number
): PushResult {
  db.updateCollectionStatus(collection.id, 'pushed', { absCollectionId, pushedAt: now });
  db.finishLog(logId, 'success', { action, absCollectionId, name: finalName }, now);
  return { collectionId: collection.id, absCollectionId, action, finalName };
}
