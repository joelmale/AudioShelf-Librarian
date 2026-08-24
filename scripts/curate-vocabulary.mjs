#!/usr/bin/env node
/**
 * Vocabulary consolidation runner (librarian engine plan §3 "Promotion loop").
 *
 * The Phase 3.5 retag produced a working canonical body (length covers 97% of
 * the library, era/pacing/mood/genre all land on seed terms) plus a long
 * out-of-vocabulary tail: genres the seed vocabulary never anticipated
 * (adventure, mystery, horror, western, comedy), near-duplicate spellings, and
 * tags where the model echoed the category name back at us.
 *
 * All three fixes here are RETROACTIVE and cost no LLM tokens:
 *   - promote  flips existing `llm-open` rows for that term to source='vocab'
 *   - alias    renames the tag on every book AND folds the queue entry away
 *   - reject   marks the term non-promotable
 *
 * IMPORTANT — what reject does NOT do: it only sets the term's status. It does
 * not delete the tag from any book. `derry-maine` stays on all 118 books as an
 * `llm-open` setting tag after rejection; it just stops being a promotion
 * candidate. Removing it needs either a per-term delete endpoint (doesn't
 * exist) or a direct SQL fix. See REJECT_EXPLICIT for the ones that matter.
 *
 * Ordering is load-bearing: POST /vocab/alias rejects a canonical target that
 * is not already a seed or promoted term, so promotes must land first.
 *
 * Usage:
 *   node scripts/curate-vocabulary.mjs --base-url https://librarian.example
 *   node scripts/curate-vocabulary.mjs --base-url ... --apply
 *   node scripts/curate-vocabulary.mjs --base-url ... --apply --only=promote
 */

const args = process.argv.slice(2);
/** Accepts both `--name=value` and `--name value`; a bare `--name` is true. */
const flag = (name, fallback = undefined) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return fallback;
  const eq = args[i].indexOf('=');
  if (eq !== -1) return args[i].slice(eq + 1);
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const BASE_URL = String(flag('base-url', process.env.LIBRARIAN_URL || '')).replace(/\/$/, '');
const APPLY = flag('apply', false) === true;
const ONLY = flag('only', null);

if (!BASE_URL) {
  console.error('Missing --base-url (or LIBRARIAN_URL). Example:');
  console.error('  node scripts/curate-vocabulary.mjs --base-url https://librarian.home.example');
  process.exit(1);
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Terms to make canonical. Counts are from the 2026-08-23 retag and are only
 * a comment — the script reads live state and skips anything that has already
 * moved. Promotes run first so aliases below have a valid target.
 */
const PROMOTE = [
  // Genres the seed vocabulary never covered. The seed was sci-fi-shaped
  // (hard-sci-fi / military-sci-fi / space-opera / cyberpunk / fantasy /
  // thriller); this library is much broader.
  ['adventure', 'genre'],            // 133
  ['mystery', 'genre'],              // 62
  ['horror', 'genre'],               // 45
  ['western', 'genre'],              // 26
  ['comedy', 'genre'],               // 25
  ['historical-fiction', 'genre'],   // 21
  ['literary-fiction', 'genre'],     // 21
  ['science-fiction', 'genre'],      // 32 — umbrella above hard-/military-/space-opera
  ['psychological-horror', 'genre'], // 13
  ['crime-fiction', 'genre'],        // 11
  ['noir', 'genre'],                 // 11
  ['memoir', 'genre'],               // 9
  ['cozy-mystery', 'genre'],         // 8
  ['military', 'genre'],             // 8 — non-sf military
  ['litrpg', 'genre'],               // 7
  ['steampunk', 'genre'],            // 7
  ['graphic-novel', 'genre'],        // 6
  ['non-fiction', 'genre'],          // 3
  ['satire', 'genre'],               // 5
  ['romantic-comedy', 'genre'],      // 5
  ['police-procedural', 'genre'],    // 4
  ['biography', 'genre'],            // 4
  ['espionage', 'genre'],            // 4

  // Themes.
  ['exploration', 'theme'],          // 51
  ['war', 'theme'],                  // 49
  ['coming-of-age', 'theme'],        // 32
  ['magic', 'theme'],                // 28
  ['crime', 'theme'],                // 23
  ['good-vs-evil', 'theme'],         // 19
  ['family-drama', 'theme'],         // 17
  ['conspiracy', 'theme'],           // 14
  ['self-discovery', 'theme'],       // 12
  ['social-commentary', 'theme'],    // 12
  ['mythology', 'theme'],            // 10
  ['paranormal', 'theme'],           // 10
  ['alternate-history', 'theme'],    // 9
  ['apocalyptic', 'theme'],          // 9
  ['espionage', 'theme'],            // 9
  ['investigation', 'theme'],        // 9
  ['revenge', 'theme'],              // 7
  ['zombies', 'theme'],              // 7
  ['magical-system', 'theme'],       // 6
  ['grief', 'theme'],                // 5
  ['serial-killer', 'theme'],        // 5
  ['vampire', 'theme'],              // 3
  ['monster-hunting', 'theme'],      // 2

  // Tropes — the thinnest facet by ~5x. Canonical trope vocabulary was only
  // five terms (unreliable-narrator, found-family, love-triangle, chosen-one,
  // hard-magic), which is why negative filtering under-excludes.
  ['quest', 'trope'],                // 17
  ['political-intrigue', 'trope'],   // 13
  ['heroic', 'trope'],               // 10
  ['combat', 'trope'],               // 9
  ['conspiracy', 'trope'],           // 8
  ['hero', 'trope'],                 // 7
  ['prophecy', 'trope'],             // 5
  ['survivalist', 'trope'],          // 5
  ['treasure-hunt', 'trope'],        // 5
  ['revenge', 'trope'],              // 4
  ['monster', 'trope'],              // 4
  ['coming-of-age', 'trope'],        // 3
  ['lone-wolf', 'trope'],            // 3
  ['red-herring', 'trope'],          // 3
  ['hero-s-journey', 'trope'],       // 2
  ['good-vs-evil', 'trope'],         // 4 — alias target for good-versus-evil

  // Moods.
  ['suspense', 'mood'],              // 54
  ['grimdark', 'mood'],              // 42
  ['light-hearted', 'mood'],         // 21
  ['philosophical', 'mood'],         // 28
  ['satirical', 'mood'],             // 11
  ['optimistic', 'mood'],            // 14
  ['atmospheric', 'mood'],           // 9

  // Pacing / structure.
  ['complex-plot', 'pacing'],        // 30
  ['character-driven', 'pacing'],    // 15
  ['first-person', 'structure'],     // 32
];

/**
 * [alias, canonical, category] — the alias's tags are renamed to the canonical
 * term on every book. Cross-category folds are NOT possible: POST /vocab/alias
 * takes one category, so `mood:adventure` cannot be folded into
 * `genre:adventure`. Those are left alone deliberately; see the report.
 */
const ALIAS = [
  // Structure: the model wrote the non-canonical spelling 6:1.
  ['multiple-pov', 'multi-pov', 'structure'],            // 86 — biggest single win
  ['narrative-multi-pov', 'multi-pov', 'structure'],
  ['narrative-multiple-pov', 'multi-pov', 'structure'],
  ['dual-pov', 'multi-pov', 'structure'],
  ['triple-pov', 'multi-pov', 'structure'],
  ['short-story-collection', 'anthology', 'structure'],
  ['short-stories', 'anthology', 'structure'],
  ['short-story', 'anthology', 'structure'],
  ['collection', 'anthology', 'structure'],

  // Category-name prefixes the model bolted on.
  ['trope-chosen-one', 'chosen-one', 'trope'],           // 10
  ['trope-unreliable-narrator', 'unreliable-narrator', 'trope'],
  ['trope-quest', 'quest', 'trope'],
  ['tropes-quest', 'quest', 'trope'],
  ['trope-coming-of-age', 'coming-of-age', 'trope'],
  ['trope-hero-s-journey', 'hero-s-journey', 'trope'],
  ['trope-prophecy', 'prophecy', 'trope'],
  ['trope-hero', 'hero', 'trope'],

  // Genre duplicates.
  ['sci-fi', 'science-fiction', 'genre'],                // 27
  ['literary', 'literary-fiction', 'genre'],             // 27
  ['literature-fiction', 'literary-fiction', 'genre'],
  ['literature', 'literary-fiction', 'genre'],
  ['horror-fiction', 'horror', 'genre'],
  ['horror-literature', 'horror', 'genre'],
  ['horror-lit', 'horror', 'genre'],
  ['crime', 'crime-fiction', 'genre'],
  ['humorous-fiction', 'comedy', 'genre'],
  ['comedy-humor', 'comedy', 'genre'],
  ['humor', 'comedy', 'genre'],
  ['nonfiction', 'non-fiction', 'genre'],
  ['historical-nonfiction', 'non-fiction', 'genre'],
  ['historical-non-fiction', 'non-fiction', 'genre'],
  ['autobiography', 'memoir', 'genre'],
  ['personal-memoir', 'memoir', 'genre'],
  ['celebrity-memoir', 'memoir', 'genre'],
  ['political-memoir', 'memoir', 'genre'],
  ['historical', 'historical-fiction', 'genre'],
  ['satirical-fiction', 'satire', 'genre'],
  ['vintage-mystery', 'mystery', 'genre'],
  ['historical-mystery', 'mystery', 'genre'],
  ['british-mystery', 'mystery', 'genre'],
  ['detective-fiction', 'crime-fiction', 'genre'],
  ['spy-fiction', 'espionage', 'genre'],

  // Theme duplicates. `ai` and `post-apocalyptic` and `dystopian` are already
  // canonical, so these fold straight in.
  ['artificial-intelligence', 'ai', 'theme'],            // 12 — free win
  ['post-holocaust', 'post-apocalyptic', 'theme'],
  ['post-nuclear', 'post-apocalyptic', 'theme'],
  ['distopian', 'dystopian', 'theme'],                   // outright typo
  ['magical', 'magic', 'theme'],
  ['magic-system', 'magical-system', 'theme'],
  ['apocalypse', 'apocalyptic', 'theme'],
  ['good-versus-evil', 'good-vs-evil', 'theme'],
  ['family-secrets', 'family-drama', 'theme'],
  ['family-dynamics', 'family-drama', 'theme'],
  ['family-saga', 'family-drama', 'theme'],
  ['societal-commentary', 'social-commentary', 'theme'],
  ['international-espionage', 'espionage', 'theme'],
  ['investigative', 'investigation', 'theme'],
  ['monster-fighting', 'monster-hunting', 'theme'],
  ['zombie-apocalypse', 'zombies', 'theme'],
  ['vampires', 'vampire', 'theme'],

  // Mood duplicates.
  ['comedy', 'humorous', 'mood'],                        // 22
  ['humor', 'humorous', 'mood'],
  ['suspenseful', 'suspense', 'mood'],                   // 16
  ['lighthearted', 'light-hearted', 'mood'],
  ['light', 'light-hearted', 'mood'],
  ['light-humor', 'light-hearted', 'mood'],
  ['grim', 'grimdark', 'mood'],
  ['satire', 'satirical', 'mood'],
  ['black-humor', 'humorous', 'mood'],
  ['british-humor', 'humorous', 'mood'],
  ['observational-humor', 'humorous', 'mood'],

  // Pacing / trope duplicates.
  ['complex-narrative', 'complex-plot', 'pacing'],
  ['intricate-plot', 'complex-plot', 'pacing'],
  ['monster-hunt', 'monster', 'trope'],
  ['monster-hunter', 'monster', 'trope'],
  ['monster-hunting', 'monster', 'trope'],
  ['good-versus-evil', 'good-vs-evil', 'trope'],
];

/**
 * Terms rejected by shape. Every one of these is the model leaking the schema
 * into the value — `trope-underdog`, `setting-mundania`, `locations-island`,
 * or the literal category name as its own tag.
 */
const REJECT_PATTERNS = [
  /^(trope|tropes|setting|mood|theme|audience|pacing|structure|locations)-/,
];

/** Terms rejected by name: junk, series-as-genre, and the bad settings. */
const REJECT_EXPLICIT = [
  // The worst data error in the run: Derry, Maine applied to 118 books
  // including A Clockwork Orange and All Systems Red. NOTE: rejecting does not
  // strip the tag — see the module docblock.
  ['derry-maine', 'setting'],
  ['derry-mars', 'setting'],
  ['winterfell-maine', 'setting'],
  ['chester-maine', 'setting'],

  // Junk / non-tags.
  ['none', 'trope'],
  ['no-tropes', 'trope'],
  ['unknown', 'theme'],
  ['unknown', 'setting'],
  ['audiobook', 'genre'],
  ['narrated-audiobook', 'audience'],
  ['narrated-audiobook', 'structure'],
  ['graphic-audio', 'genre'],
  ['graphic-audio', 'structure'],
  ['fre-ac-converter', 'genre'],
  ['free-software', 'genre'],
  ['converter', 'setting'],
  ['software', 'setting'],
  ['netflix-original', 'genre'],
  ['netflix-original', 'setting'],
  ['genre', 'genre'],
  ['theme', 'theme'],
  ['mood', 'mood'],
  ['pacing', 'pacing'],
  ['structure', 'structure'],
  ['audience', 'audience'],
  ['setting', 'setting'],
  ['relatable', 'theme'],
  ['relatable', 'audience'],
  ['relatable', 'mood'],
  ['uncertain', 'audience'],

  // Series names filed as genres. A genre facet has to generalise.
  ['deathlands-series', 'genre'],
  ['deathlands-western', 'genre'],
  ['deathlands', 'genre'],
  ['redwall-series', 'genre'],
  ['discworld', 'genre'],
  ['xanth-series', 'genre'],
  ['prydain-chronicles', 'genre'],
  ['star-wars-legends', 'genre'],
  ['diary-of-a-wimpy-kid', 'genre'],
  ['dragonriders-of-pern', 'genre'],
  ['southern-vampire', 'genre'],
  ['southern-vampire-mystery', 'genre'],
  ['southern-vampire-mysteries', 'genre'],
  ['southern-vampire-mythology', 'genre'],
  ['getaway-bay-mystery', 'genre'],
  ['beach-town-mystery', 'genre'],
  ['riverworld', 'genre'],
  ['pratchett', 'genre'],
  ['pratchett', 'theme'],
  ['pratchett', 'character'],
  ['stoat-warrior', 'genre'],
  ['raccoon-noir', 'genre'],
  ['sword-rattling', 'genre'],
];

// ── Runner ──────────────────────────────────────────────────────────────────

const key = (term, category) => `${category}:${term}`;

async function get(path) {
  const res = await fetch(`${BASE_URL}/api${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(parsed?.error || `POST ${path} failed (${res.status})`);
  return parsed;
}

const stats = { promoted: 0, aliased: 0, rejected: 0, retagged: 0, skipped: 0, failed: 0 };
const skips = [];

function skip(action, term, category, why) {
  stats.skipped += 1;
  skips.push(`${action.padEnd(7)} ${key(term, category).padEnd(44)} ${why}`);
}

async function main() {
  console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'} ${BASE_URL}\n`);

  const [quality, proposed, vocabulary] = await Promise.all([
    get('/tags/quality'),
    get('/vocab/proposed'),
    get('/tags/vocabulary'),
  ]);

  // A term is canonical when it carries tags but is absent from the OOV report.
  const oov = new Set(quality.outOfVocabulary.map((t) => key(t.tag, t.category)));
  const proposedSet = new Set(proposed.map((t) => key(t.term, t.category)));
  const counts = new Map(proposed.map((t) => [key(t.term, t.category), t.bookCount]));

  console.log(`Live state: ${proposed.length} proposed terms, ${oov.size} out-of-vocabulary entries.\n`);

  // A term is canonical when it carries tags but is absent from the OOV report.
  // `canonical` accumulates this run's promotes so alias targets validate in
  // dry-run too; `handled` stops the reject phase re-hitting terms the alias
  // phase already resolved (POST /vocab/alias sets its source term to
  // 'rejected', and reject would then 404 on the proposed-status lookup).
  const inUse = new Set(vocabulary.map((t) => key(t.tag, t.category)));
  const canonical = new Set();
  const handled = new Set();
  const isCanonical = (term, category) => {
    const k = key(term, category);
    return canonical.has(k) || (inUse.has(k) && !oov.has(k));
  };

  // ── Phase 1: promote ──
  if (!ONLY || ONLY === 'promote') {
    console.log('── PROMOTE ──');
    for (const [term, category] of PROMOTE) {
      const k = key(term, category);
      if (!proposedSet.has(k)) {
        skip('promote', term, category, isCanonical(term, category) ? 'already canonical' : 'not in queue');
        continue;
      }
      if (!APPLY) {
        console.log(`  would promote ${k.padEnd(40)} (${counts.get(k) ?? '?'} books)`);
        canonical.add(k);
        handled.add(k);
        stats.promoted += 1;
        continue;
      }
      try {
        const r = await post('/vocab/promote', { term, category });
        console.log(`  promoted ${k.padEnd(40)} retagged ${r.retagged}`);
        canonical.add(k);
        handled.add(k);
        stats.promoted += 1;
        stats.retagged += r.retagged;
      } catch (e) {
        stats.failed += 1;
        console.log(`  FAILED   ${k.padEnd(40)} ${e.message}`);
      }
    }
    console.log('');
  }

  // ── Phase 2: alias ──
  if (!ONLY || ONLY === 'alias') {
    console.log('── ALIAS ──');
    for (const [alias, target, category] of ALIAS) {
      const ak = key(alias, category);
      const tk = key(target, category);
      if (!isCanonical(target, category)) {
        skip('alias', alias, category, `target ${tk} is not canonical (promote it first)`);
        continue;
      }
      if (!proposedSet.has(ak) && !oov.has(ak)) {
        skip('alias', alias, category, 'no tags carry this term');
        continue;
      }
      if (!APPLY) {
        console.log(`  would fold ${ak.padEnd(40)} -> ${target} (${counts.get(ak) ?? '?'} books)`);
        handled.add(ak);
        stats.aliased += 1;
        continue;
      }
      try {
        const r = await post('/vocab/alias', { alias, canonical: target, category });
        console.log(`  folded   ${ak.padEnd(40)} -> ${target}  retagged ${r.retagged}`);
        handled.add(ak);
        stats.aliased += 1;
        stats.retagged += r.retagged;
      } catch (e) {
        stats.failed += 1;
        console.log(`  FAILED   ${ak.padEnd(40)} ${e.message}`);
      }
    }
    console.log('');
  }

  // ── Phase 3: reject ──
  if (!ONLY || ONLY === 'reject') {
    console.log('── REJECT ──');
    const explicit = new Set(REJECT_EXPLICIT.map(([t, c]) => key(t, c)));
    const targets = proposed.filter((t) => {
      const k = key(t.term, t.category);
      if (handled.has(k)) return false;
      if (explicit.has(k)) return true;
      return REJECT_PATTERNS.some((re) => re.test(t.term));
    });

    for (const t of targets) {
      const k = key(t.term, t.category);
      if (!APPLY) {
        console.log(`  would reject ${k.padEnd(44)} (${t.bookCount} books)`);
        stats.rejected += 1;
        continue;
      }
      try {
        await post('/vocab/reject', { term: t.term, category: t.category });
        console.log(`  rejected ${k.padEnd(44)} (${t.bookCount} books, tags NOT removed)`);
        stats.rejected += 1;
      } catch (e) {
        stats.failed += 1;
        console.log(`  FAILED   ${k.padEnd(44)} ${e.message}`);
      }
    }
    console.log('');
  }

  if (skips.length) {
    console.log('── SKIPPED ──');
    for (const s of skips) console.log(`  ${s}`);
    console.log('');
  }

  console.log('── SUMMARY ──');
  console.log(`  promoted ${stats.promoted}  aliased ${stats.aliased}  rejected ${stats.rejected}`);
  console.log(`  skipped  ${stats.skipped}  failed  ${stats.failed}`);
  if (APPLY) console.log(`  tag rows retagged: ${stats.retagged}`);
  else console.log('\n  Dry run. Re-run with --apply to execute.');

  if (APPLY && (stats.promoted || stats.aliased)) {
    console.log('\n  Book cards changed, so embeddings are now stale. Run stage 4.');
  }
}

main().catch((e) => {
  console.error(`\nAborted: ${e.message}`);
  process.exit(1);
});
