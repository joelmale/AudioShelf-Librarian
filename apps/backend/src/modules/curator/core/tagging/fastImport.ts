/**
 * OCLC FAST alias importer (librarian engine plan §2, "Offline datasets").
 *
 * FAST (Faceted Application of Subject Terminology) ships as an N-triples
 * dump of ~1.7M subject-heading concepts, each with one `skos:prefLabel` and
 * zero or more `skos:altLabel` variant labels. Importing the whole thing
 * would swamp our small curated vocabulary with noise, so this is
 * deliberately scoped narrower: a FAST concept only contributes aliases when
 * its `prefLabel` already normalizes onto a term already living in our
 * vocabulary (seed or promoted). When it does, every altLabel becomes a
 * `tag_aliases` row pointing at that vocab term — giving the canonicalizer
 * (`./canonicalize.ts`) professional variant labels ("Staying alive" ->
 * `survival`) without ever inventing a new vocab term from the dump.
 */
import type { CuratorDb } from '../db.js';
import type { TagCategory } from '../types.js';
import { normalizeTagForm } from './canonicalize.js';

export interface FastEntry {
  uri: string;
  prefLabel: string;
  altLabels: string[];
}

const PREF_LABEL_PREDICATE = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const ALT_LABEL_PREDICATE = 'http://www.w3.org/2004/02/skos/core#altLabel';

// `<subject> <predicate> "literal"[@lang | ^^<datatype>] .` — the standard
// N-triples triple-with-literal-object shape. Any other line shape (a
// resource-object triple, a comment, a blank line, truncated garbage) simply
// fails to match and is skipped by the caller.
const TRIPLE_RE = /^<([^>\s]+)>\s+<([^>\s]+)>\s+"((?:\\.|[^"\\])*)"(?:@[A-Za-z-]+|\^\^<[^>]+>)?\s*\.$/;

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(.)/g, (_match, ch: string) => {
    switch (ch) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return ch;
    }
  });
}

/**
 * Parse a stream of N-triples lines into per-subject {@link FastEntry}
 * records, keeping only `prefLabel`/`altLabel` predicates (every other
 * predicate — `broader`, `narrower`, `rdf:type`, etc. — is ignored). Entries
 * with no `prefLabel` line are dropped: an alt-only subject can't be matched
 * against our vocabulary. Garbage/blank/malformed lines are skipped silently
 * so a real dump's non-literal triples don't abort the parse.
 */
export function parseFastNTriples(lines: Iterable<string>): FastEntry[] {
  const bySubject = new Map<string, { prefLabel: string | null; altLabels: string[] }>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const match = TRIPLE_RE.exec(line);
    if (!match) continue;
    const [, subject, predicate, literalRaw] = match;
    if (predicate !== PREF_LABEL_PREDICATE && predicate !== ALT_LABEL_PREDICATE) continue;

    let entry = bySubject.get(subject);
    if (!entry) {
      entry = { prefLabel: null, altLabels: [] };
      bySubject.set(subject, entry);
    }

    const literal = unescapeLiteral(literalRaw);
    if (predicate === PREF_LABEL_PREDICATE) {
      if (entry.prefLabel === null) entry.prefLabel = literal;
    } else {
      entry.altLabels.push(literal);
    }
  }

  const out: FastEntry[] = [];
  for (const [uri, entry] of bySubject) {
    if (entry.prefLabel === null) continue;
    out.push({ uri, prefLabel: entry.prefLabel, altLabels: entry.altLabels });
  }
  return out;
}

/**
 * Import FAST-derived aliases for `entries` into `category`. Only entries
 * whose normalized `prefLabel` is already an in-vocabulary term (seed or
 * promoted — see `CuratorDb.isVocabTerm`) contribute anything; every other
 * entry is skipped entirely, which is what keeps this bounded to "aliases
 * for terms we already have" rather than importing the whole FAST facet.
 *
 * Within a matched entry, an altLabel is skipped (never aliased) when its
 * normalized form is identical to the canonical term, or when it is itself
 * an in-vocabulary term for this category — we never want to alias a real
 * vocab term away to another one.
 */
export function importFastAliases(
  db: CuratorDb,
  entries: FastEntry[],
  category: TagCategory
): { matched: number; aliasesAdded: number } {
  let matched = 0;
  let aliasesAdded = 0;

  for (const entry of entries) {
    const norm = normalizeTagForm(entry.prefLabel);
    if (norm === '' || !db.isVocabTerm(norm, category)) continue;
    matched++;

    for (const altLabel of entry.altLabels) {
      const aliasNorm = normalizeTagForm(altLabel);
      if (aliasNorm === '' || aliasNorm === norm) continue;
      if (db.isVocabTerm(aliasNorm, category)) continue;
      db.upsertTagAlias(aliasNorm, norm, category);
      aliasesAdded++;
    }
  }

  return { matched, aliasesAdded };
}
