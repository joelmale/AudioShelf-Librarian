# Collection Scanner Enhancement Plan

Add a **Split collection** workflow to Intake. AudioShelf should identify book boundaries in a completed download, show the proposed groups and their evidence, and send approved books through the existing importer. A collection can have both ready books and unresolved files.

The analyzer and reviewed import workflow are implemented in the workspace. Intake runs imports in the background and reports progress per selected book. A read-only check of the six recordings still in the NAS review folder assigned all 41 audio files. Broader accuracy measurement follows deployment.

## Original intake behavior

Automatic intake in `librarian/index.ts` sent one inbox path to `MetadataScanner.scanTarget` with `inboxEntry: true` and expected one `OrganizationAction`. The scanner held directories with audio in multiple ordinary subfolders and loose groups that could not be represented by a single safe source path. Manual discovery could treat several distinct M4Bs inside a series folder as one book.

The four reported downloads cover two important layouts. The Jasper Fforde downloads contain 12 book folders across three series, including book folders with a redundant wrapper around the MP3 tracks. The Brandon Sanderson download contains 55 M4Bs across the pack root and eight subfolders. The advertised count is 54. Several standalone recordings share the album tag `Arcanum Unbounded`, and the `White Sand` title and album tags disagree on the volume range. Surface those conflicts and keep anthologies and combined editions intact.

## Phase 1 — Read-only collection analysis

1. Add a collection analyzer in `apps/backend/src/modules/librarian/services/`. Share audio extension and part-folder detection with the scanner. Inventory regular files under a selected inbox target with containment checks, bounded traversal and metadata reads, deterministic ordering, and cancellation. Skip symlinks and report unreadable entries. Allow acquisition and Intake to use the same analyzer.
2. Recognize book folders beneath author and series wrappers, including these layouts:
   - One title folder containing tracks, numbered disc or part folders, or a single title wrapper.
   - Distinct standalone M4Bs in a shared folder, including nested series and loose titles in the pack root.
   - Loose multipart audio with corroborating album, artist, track or disc, and filename evidence. Treat generic album names, conflicting titles, and repeated track sequences as ambiguous unless a book folder supplies a reliable boundary.
3. Model each candidate with ordered file membership, proposed title and author, book-boundary evidence, and a review reason when necessary. Track series position separately from disc or part order. Associate artwork and sidecars only when ownership is clear. List unassigned audio and extras separately. Keep filename and embedded metadata evidence available to the reviewer, including edition and narration signals.
4. Expose a preview for held inbox items. Keep the existing single-book import path. Detect likely collections before either automatic or manual scanning can plan a parent move that would combine multiple books. Any file contributing to a candidate must appear in at most one group.

## Phase 2 — Intake review and import

1. Add **Split collection** to the held item's Intake actions. Show title, author, file count, duration when available, and why AudioShelf grouped the files. Let the reviewer approve a subset, correct titles, combine or split groups, and leave extras unassigned. Show potential duplicates and editions using the existing library checks. Represent the acquisition and its intake item as one collection with per-book progress.
2. Persist approved membership, a source fingerprint, and per-book status. Revalidate the source when importing, and return changed groups to review. Materialize only approved files into per-book staging paths, preserve track order and clearly owned sidecars, and expose each complete staging directory atomically. Keep the original source available for seeding and retries. Reuse the existing organizer and ingest runner for the final book move.
3. Key retries by collection, source revision, and book identity. Claim work so poller and manual actions cannot run the same import concurrently. Persist each result and report partial completion with explicit counts for imported, held, failed, and remaining books. Leave ambiguous or combined audio untouched. Combined recordings can be imported as an omnibus after confirmation. Splitting audio at chapter boundaries is separate work.

## Phase 3 — Expand coverage

Measure candidate accuracy on representative packs after the review flow ships. Add deterministic patterns from recurring failures. Consider optional metadata or LLM suggestions for ambiguous titles after measuring where evidence-based grouping falls short. Suggestions require confirmation when file membership is unclear.

When source files change after an approval, Intake releases the affected unfinished group for a new review. Its previous staged copy may still contain an earlier version of the audio and remains under `.collection-staging` for recovery.

## Collection import policy

Intake opens to the collection queue. Activity links for a held pack open that pack directly. The review screen separates ready books, review exceptions, and imported books. Select clear matches to approve a batch, or open a book's details to edit metadata or regroup its files.

Review first is the default. An administrator can choose Auto-import clear matches for newly discovered packs. Existing held packs still have the one-click selection option. Automatic work is recorded in SQLite and can wait for a busy scanner or another import. When the duplicate check is unavailable, AudioShelf leaves the pack for review.

Standalone MP3s can qualify when they contain a single book-length recording and their title and author tags agree with the filename. Multipart books need corroborating album and author tags, continuous numbering, and declared totals. Additional copies of the same title, combined recordings, incomplete inventories, and conflicting evidence remain available for review. All imports use staged copies and the existing per-book ingest history.

## Acceptance checks

- Synthetic Nursery Crime, Thursday Next, and Last Dragonslayer layouts yield 2, 7, and 3 groups respectively. Extra wrappers and book-owned sidecars stay with their book, and tracks retain their order.
- A synthetic Sanderson layout with 55 distinct M4Bs, a 54-title listing, and a pack-level text file yields 55 file assignments for review. Anthologies and dramatized editions retain their identities, and the text file remains pack-level.
- A single book with multiple discs stays one book. Flat tracks with conflicting tags or generic names remain unassigned until reviewed. Explicit audiobook parts stay together, and title matches alone never collapse separate editions.
- Read-only previews leave source and library files untouched. Tests cover disappearing or replaced files, symlink escape attempts, collisions, partial staging failures, parallel approval attempts, and a restart after some books succeed. Use temporary filesystem fixtures and the synthetic browser harness for the Intake workflow.
- Verify single-book acquisition and manual scanning still work. Validate real-pack preview with filesystem writes disabled before enabling reviewed imports.
