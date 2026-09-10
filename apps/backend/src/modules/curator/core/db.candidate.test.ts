import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuratorDb } from './db.js';
import { RevisionConflictError } from './errors.js';
import { generateCandidateId } from './candidateId.js';

describe('CuratorDb — Candidates, Durable Intents & Source Snapshots (Phase 3)', () => {
  let tempDir: string;
  let dbPath: string;
  let db: CuratorDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'curator-candidate-test-'));
    dbPath = join(tempDir, 'test.db');
    db = new CuratorDb(dbPath);
  });

  afterEach(() => {
    try {
      (db as any).db.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs migrations idempotently across repeated DB reopenings', () => {
    // Close and reopen the same database
    (db as any).db.close();
    const reopened = new CuratorDb(dbPath);
    expect(reopened.getSourceSnapshots()).toEqual([]);
    (reopened as any).db.close();
    // Reopen a third time
    const reopenedAgain = new CuratorDb(dbPath);
    expect(reopenedAgain.getSourceSnapshots()).toEqual([]);
    (reopenedAgain as any).db.close();
  });

  it('preserves 40 candidate intents across database restart', () => {
    const actorId = 'internal';

    // Insert 40 candidates and their intents
    for (let i = 1; i <= 40; i++) {
      const id = generateCandidateId('audible', `item_${i}`);
      const intentType = i % 3 === 0 ? 'want' : i % 3 === 1 ? 'later' : 'pass';
      db.setCandidateIntent({
        actorId,
        candidateId: id,
        intent: intentType,
        candidateMetadata: {
          title: `Book Title ${i}`,
          author: `Author ${i}`,
          source: 'audible',
          sourceItemId: `item_${i}`,
          coverUrl: `https://example.com/cover_${i}.jpg`,
        },
      });
    }

    // Verify 40 intents exist
    const intentsBefore = db.getCandidateIntents(actorId);
    expect(Object.keys(intentsBefore).length).toBe(40);

    // Close and restart database
    (db as any).db.close();
    db = new CuratorDb(dbPath);

    // Verify all 40 intents and their candidate metadata survived
    const intentsAfter = db.getCandidateIntents(actorId);
    expect(Object.keys(intentsAfter).length).toBe(40);
    expect(intentsAfter[generateCandidateId('audible', 'item_1')].intent).toBe('later');
    expect(intentsAfter[generateCandidateId('audible', 'item_3')].intent).toBe('want');

    const saved = db.listSavedCandidates(actorId, { limit: 50 });
    expect(saved.length).toBe(40);
    const item3 = saved.find((s) => s.candidate.title === 'Book Title 3');
    expect(item3).toBeDefined();
    expect(item3?.intent.intent).toBe('want');
    expect(item3?.candidate.coverUrl).toBe('https://example.com/cover_3.jpg');
  });

  it('guarantees idempotency on duplicate requests with the same requestId', () => {
    const candidateId = generateCandidateId('apple', '123456');
    const requestId = 'req-first-try-1';

    // First mutation
    const first = db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'want',
      requestId,
      candidateMetadata: {
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        source: 'apple',
      },
    });
    expect(first.changed).toBe(true);
    expect(first.intent.revision).toBe(1);

    // Duplicate request with identical requestId and intent
    const duplicate = db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'want',
      requestId,
    });
    expect(duplicate.changed).toBe(false);
    expect(duplicate.intent.revision).toBe(1);
    expect(duplicate.intent.intent).toBe('want');
  });

  it('rejects stale revisions with RevisionConflictError (409 Conflict)', () => {
    const candidateId = generateCandidateId('audible', 'B08G9W2925');

    // Create initial intent at revision 1
    const res1 = db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'want',
      candidateMetadata: {
        title: 'Dune',
        author: 'Frank Herbert',
        source: 'audible',
      },
    });
    expect(res1.intent.revision).toBe(1);

    // Client attempts to mutate using a stale expected revision (e.g. 0)
    expect(() => {
      db.setCandidateIntent({
        actorId: 'internal',
        candidateId,
        intent: 'pass',
        expectedRevision: 0,
      });
    }).toThrow(RevisionConflictError);

    // Client uses correct expectedRevision (1) -> succeeds, advances to revision 2
    const res2 = db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'later',
      expectedRevision: 1,
    });
    expect(res2.intent.revision).toBe(2);
    expect(res2.intent.intent).toBe('later');
  });

  it('supports reversible undo of triage intent', () => {
    const candidateId = generateCandidateId('audiobooksnow', 'book-999');

    // 1. Set to 'want'
    db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'want',
      candidateMetadata: {
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        source: 'audiobooksnow',
      },
    });

    // 2. Change to 'pass'
    db.setCandidateIntent({
      actorId: 'internal',
      candidateId,
      intent: 'pass',
    });

    const currentBeforeUndo = db.getCandidateIntents('internal', [candidateId]);
    expect(currentBeforeUndo[candidateId].intent).toBe('pass');

    // 3. Undo: reverts back to 'want'
    const undo1 = db.undoCandidateIntent({
      actorId: 'internal',
      candidateId,
    });
    expect(undo1.changed).toBe(true);
    expect(undo1.intent?.intent).toBe('want');
    expect(undo1.previousIntent).toBe('pass');

    // 4. Undo again: reverts back to none (removed)
    const undo2 = db.undoCandidateIntent({
      actorId: 'internal',
      candidateId,
    });
    expect(undo2.changed).toBe(true);
    expect(undo2.intent).toBeNull();
    expect(undo2.previousIntent).toBe('want');

    const afterAllUndos = db.getCandidateIntents('internal', [candidateId]);
    expect(afterAllUndos[candidateId]).toBeUndefined();
  });

  it('isolates intents between distinct actors', () => {
    const candidateId = generateCandidateId('audible', 'B001');

    db.upsertCandidate({
      id: candidateId,
      title: 'Common Title',
      author: 'Common Author',
      source: 'audible',
    });

    // Actor A sets 'want'
    db.setCandidateIntent({
      actorId: 'user-alice',
      candidateId,
      intent: 'want',
    });

    // Actor B sets 'pass'
    db.setCandidateIntent({
      actorId: 'user-bob',
      candidateId,
      intent: 'pass',
    });

    const aliceIntents = db.getCandidateIntents('user-alice', [candidateId]);
    const bobIntents = db.getCandidateIntents('user-bob', [candidateId]);
    const internalIntents = db.getCandidateIntents('internal', [candidateId]);

    expect(aliceIntents[candidateId]?.intent).toBe('want');
    expect(bobIntents[candidateId]?.intent).toBe('pass');
    expect(internalIntents[candidateId]).toBeUndefined();
  });

  it('does not silently merge candidates from different sources sharing title/author', () => {
    const audibleId = generateCandidateId('audible', 'ASIN123', 'The Hobbit', 'J.R.R. Tolkien');
    const appleId = generateCandidateId('apple', 'APPLE456', 'The Hobbit', 'J.R.R. Tolkien');

    db.upsertCandidate({
      id: audibleId,
      title: 'The Hobbit',
      author: 'J.R.R. Tolkien',
      source: 'audible',
      sourceItemId: 'ASIN123',
    });

    db.upsertCandidate({
      id: appleId,
      title: 'The Hobbit',
      author: 'J.R.R. Tolkien',
      source: 'apple',
      sourceItemId: 'APPLE456',
    });

    expect(audibleId).not.toBe(appleId);

    db.setCandidateIntent({ actorId: 'internal', candidateId: audibleId, intent: 'want' });
    db.setCandidateIntent({ actorId: 'internal', candidateId: appleId, intent: 'later' });

    const audibleCandidate = db.getCandidate(audibleId);
    const appleCandidate = db.getCandidate(appleId);

    expect(audibleCandidate?.source).toBe('audible');
    expect(appleCandidate?.source).toBe('apple');

    const intents = db.getCandidateIntents('internal', [audibleId, appleId]);
    expect(intents[audibleId].intent).toBe('want');
    expect(intents[appleId].intent).toBe('later');
  });

  it('stores and retrieves source snapshots preserving previous snapshot when updated', () => {
    const now = Date.now();
    db.saveSourceSnapshot({
      source: 'audible',
      status: 'ready',
      lastSuccessAt: now,
      lastAttemptAt: now,
      errorMessage: null,
      attributionUrl: 'https://www.audible.com/charts/best',
      publicationDate: null,
      itemCount: 20,
      snapshotJson: JSON.stringify([{ id: 'cand_1', title: 'Book 1' }]),
      updatedAt: now,
    });

    const snapshot = db.getSourceSnapshot('audible');
    expect(snapshot).toBeDefined();
    expect(snapshot?.status).toBe('ready');
    expect(snapshot?.itemCount).toBe(20);
    expect(snapshot?.lastSuccessAt).toBe(now);

    // Provider fails later: status becomes 'stale', errorMessage is set, but previous snapshot_json and lastSuccessAt are preserved
    const later = now + 60000;
    db.saveSourceSnapshot({
      source: 'audible',
      status: 'stale',
      lastAttemptAt: later,
      errorMessage: 'HTTP 503 Service Unavailable',
      attributionUrl: 'https://www.audible.com/charts/best',
      itemCount: 20,
      snapshotJson: '[]', // empty on failure
      updatedAt: later,
    });

    const updated = db.getSourceSnapshot('audible');
    expect(updated?.status).toBe('stale');
    expect(updated?.errorMessage).toBe('HTTP 503 Service Unavailable');
    expect(updated?.lastSuccessAt).toBe(now); // preserved!
    expect(JSON.parse(updated?.snapshotJson ?? '[]')).toEqual([{ id: 'cand_1', title: 'Book 1' }]); // preserved!
  });

  it('matches candidate ownership and listening progress against books table', () => {
    // Insert a book into books table
    const bookId = 'book-fixture-1';
    (db as any).db.prepare(`
      INSERT INTO books (id, title, author, sync_status, last_synced_at)
      VALUES (?, 'Atomic Habits', 'James Clear', 'active', ?)
    `).run(bookId, Date.now());

    // Insert finished listening progress
    (db as any).db.prepare(`
      INSERT INTO listening_progress (book_id, progress, is_finished, time_listening, updated_at)
      VALUES (?, 1.0, 1, 36000, ?)
    `).run(bookId, Date.now());

    const matches = db.matchCandidateOwnership([
      { title: 'Atomic Habits', author: 'James Clear' },
      { title: 'Some Unknown Book', author: 'Some Author' },
    ]);

    const ownedMatch = matches.get('atomic habits::james clear');
    expect(ownedMatch).toBeDefined();
    expect(ownedMatch?.ownership).toBe('owned');
    expect(ownedMatch?.bookId).toBe(bookId);
    expect(ownedMatch?.isFinished).toBe(true);

    const unownedMatch = matches.get('some unknown book::some author');
    expect(unownedMatch).toBeDefined();
    expect(unownedMatch?.ownership).toBe('unowned');
    expect(unownedMatch?.isFinished).toBe(false);
  });

  it('matches candidate ownership with inverted author names, subtitles, and edition markers (David Sedaris case)', () => {
    const bookId = 'book-sedaris-1';
    (db as any).db.prepare(`
      INSERT INTO books (id, title, author, sync_status, last_synced_at)
      VALUES (?, 'The Land and Its People: Stories', 'Sedaris, David', 'active', ?)
    `).run(bookId, Date.now());

    // Candidate comes from chart as "The Land and Its People" by "David Sedaris"
    const matches = db.matchCandidateOwnership([
      { title: 'The Land and Its People', author: 'David Sedaris' },
      { title: 'Me Talk Pretty One Day', author: 'David Sedaris' },
    ]);

    const ownedMatch = matches.get('the land and its people::david sedaris');
    expect(ownedMatch).toBeDefined();
    expect(ownedMatch?.ownership).toBe('owned');
    expect(ownedMatch?.bookId).toBe(bookId);

    const differentBook = matches.get('me talk pretty one day::david sedaris');
    expect(differentBook).toBeDefined();
    expect(differentBook?.ownership).toBe('unowned');
  });

  it('matches candidate ownership with edition markers, inverted articles, and ampersands', () => {
    (db as any).db.prepare(`
      INSERT INTO books (id, title, author, sync_status, last_synced_at)
      VALUES ('b-unabridged', 'The Final Empire (Unabridged)', 'Brandon Sanderson', 'active', ?),
             ('b-ampersand', 'Good Omens: The Nice & Accurate Prophecies', 'Neil Gaiman and Terry Pratchett', 'active', ?),
             ('b-inverted', 'Hobbit, The', 'J.R.R. Tolkien', 'active', ?)
    `).run(Date.now(), Date.now(), Date.now());

    const matches = db.matchCandidateOwnership([
      { title: 'The Final Empire', author: 'Brandon Sanderson' },
      { title: 'Good Omens: The Nice and Accurate Prophecies', author: 'Neil Gaiman' },
      { title: 'The Hobbit', author: 'J.R.R. Tolkien' },
    ]);

    expect(matches.get('the final empire::brandon sanderson')?.ownership).toBe('owned');
    expect(matches.get('good omens: the nice and accurate prophecies::neil gaiman')?.ownership).toBe('owned');
    expect(matches.get('the hobbit::j.r.r. tolkien')?.ownership).toBe('owned');
  });
});
