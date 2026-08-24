#!/usr/bin/env node
/**
 * Ollama model bake-off for the three local-inference jobs this app actually runs.
 *
 *   1. metadata  — mirrors POST /scan/enhance-metadata (librarian/index.ts).
 *                  /api/generate, `format: "json"` (free-form JSON, no schema).
 *   2. tagging   — mirrors LlmClient.tagBook (curator/core/llmClient.ts).
 *                  /api/chat, `format: <json schema>` (constrained decoding).
 *   3. collections — mirrors LlmClient.autoDiscoverCollections.
 *                  /api/chat, `format: <json schema>`.
 *
 * The prompts below are copies of the production prompts. They are duplicated
 * rather than imported because those builders are module-private and the backend
 * needs a TS build to load; `npm run bench:ollama -- --check-drift` re-reads the
 * source files and warns if the copies have gone stale.
 *
 * Every metric here is objective — no LLM judge, no eyeballing:
 *   metadata    field-level accuracy against a hand-written golden set
 *   tagging     schema validity, required-category coverage, vocabulary
 *               adherence, and must-have / must-not-have tag checks. The
 *               `length` bucket is derived deterministically from duration, so
 *               it is a clean instruction-following signal.
 *   collections hallucinated-book-id rate (the failure that actually breaks the
 *               feature), collection count, empty-collection rate
 *   all         p50/p95 latency, tokens/sec, and run-to-run consistency
 *
 * Usage:
 *   node scripts/bench-ollama.mjs --models gemma3:4b,llama3.2:latest
 *   OLLAMA_URL=http://homelab:11434 node scripts/bench-ollama.mjs --models a,b --repeats 5
 *   node scripts/bench-ollama.mjs --models a,b --suites metadata --temp 0
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CASES = JSON.parse(readFileSync(join(HERE, 'bench', 'ollama-cases.json'), 'utf8'));

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { models: [], repeats: 3, suites: ['metadata', 'tagging', 'collections'], temp: null, url: process.env.OLLAMA_URL || 'http://localhost:11434', out: join(ROOT, 'bench-results'), checkDrift: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--models': out.models = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--repeats': out.repeats = Number(val()); break;
      case '--suites': out.suites = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--temp': out.temp = Number(val()); break;
      case '--url': out.url = val(); break;
      case '--out': out.out = val(); break;
      case '--check-drift': out.checkDrift = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: console.error(`Unknown flag: ${flag}`); usage(); process.exit(2);
    }
  }
  return out;
}

function usage() {
  console.log(`
bench-ollama — compare Ollama models on this app's real enrichment jobs

  --models a,b,c    models to compare (required; must already be pulled)
  --repeats N       runs per case, for consistency measurement (default 3)
  --suites list     metadata,tagging,collections (default all)
  --temp N          override temperature. Omit to use each model's default,
                    which is what production does. --temp 0 shows the ceiling.
  --url URL         Ollama base URL (default $OLLAMA_URL or localhost:11434)
  --out DIR         where to write results (default ./bench-results)
  --check-drift     verify the prompt copies still match the app source
`);
}

// ── Production prompt copies ────────────────────────────────────────────────
// Keep in sync with the sources named above; --check-drift guards these.

const TAG_SYSTEM = `You are a librarian that classifies audiobooks for a science-fiction-leaning personal library.
Return ONLY a JSON object — no prose, no markdown fences. Shape:
{"tags":[{"tag":"<kebab-case>","category":"<category>","confidence":<0.0-1.0>}]}

Categories and example vocabulary (prefer these, but you may add close variants):
- genre: hard-sci-fi, space-opera, cyberpunk, dystopian, military-sci-fi, fantasy, thriller
- mood: dark, humorous, hopeful, tense, meditative, action-driven
- theme: first-contact, ai, time-travel, post-apocalyptic, political, survival, dystopian
- era: golden-age, new-wave, modern, classic
- pacing: slow-burn, fast-paced, episodic, dense
- length: short, medium, long, epic  (use duration: <6h=short, 6-12h=medium, 12-20h=long, >20h=epic)
- audience: adult, ya, all-ages

Provide at least one tag for each of: genre, mood, theme, era, pacing, length, audience.
Confidence reflects how sure you are. Output JSON only.`;

const durationHours = (s) => (s === null || s === undefined ? 'unknown' : (s / 3600).toFixed(1));

function tagUserPrompt(book) {
  return `Classify this audiobook:
Title: ${book.title}
Author: ${book.author ?? 'unknown'}
Series: ${book.series ?? 'none'}${book.seriesSequence !== null && book.seriesSequence !== undefined ? ` (#${book.seriesSequence})` : ''}
Published: ${book.publishedYear ?? 'unknown'}
Duration (hours): ${durationHours(book.durationSeconds)}
Existing genres: ${book.genres.length > 0 ? book.genres.join(', ') : 'none'}
Description: ${book.description ? book.description.slice(0, 1500) : 'none'}`;
}

const AUTODISCOVER_SYSTEM = `You are a Master Literary Curator analyzing a personal audiobook library.
I will provide a summary of the books in this library (id, title, tags, description).
Your task is to identify 3 to 5 highly creative, specific, and unexpected collections by finding hidden thematic patterns across these books.
Do not use generic genres (like "Sci-Fi" or "Fantasy"). Look for highly specific tropes, vibes, or scenarios. For example: "Reluctant Protagonists Overthrowing Corrupt Governments", "Cozy Intergalactic Coffee Shops", or "Existential Dread Set in Space".

For each collection, provide a creative name, a short description, and exactly the book IDs that belong to it.
Return ONLY JSON in this schema:
{"collections": [{"name":"<collection name>","description":"<1-2 sentences>","bookIds":["<id>",...],"reasoning":"<short>"}]}
Use ONLY ids that appear in the provided list.`;

function metadataPrompt(book) {
  return `You are a meticulous metadata extraction assistant for audiobooks.

Analyze the following input folder path and raw data to extract clean metadata.
---
INPUT PATH: ${book.source_path}
RAW TITLE: ${book.title}
RAW AUTHOR: ${book.authors?.join(', ') || 'Unknown'}
---

RULES:
1. The overarching Series Name should be separated from the individual Book Title.
2. If the book is a novella or part of a series, extract decimal points for series numbers accurately (e.g., 0.2).
3. Do not include narrator names in the title or author.

Respond strictly using this JSON schema:
{
  "title": "Cleaned Book Title",
  "author": "Cleaned Author Name",
  "series": "Series Name",
  "series_number": 0.0
}`;
}

// JSON Schemas matching what zodToJsonSchema() emits for the production Zod schemas.
const TAG_CATEGORIES = ['genre', 'mood', 'theme', 'era', 'pacing', 'length', 'audience'];
const REQUIRED_CATEGORIES = ['genre', 'mood', 'pacing', 'length'];

const TAG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string', minLength: 1, maxLength: 60 },
          category: { type: 'string', enum: TAG_CATEGORIES },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['tag', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['tags'],
  additionalProperties: false,
};

const MULTI_COLLECTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    collections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string' },
          bookIds: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string' },
        },
        required: ['name', 'bookIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['collections'],
  additionalProperties: false,
};

// Vocabulary from curator/core/tagQuality.ts.
const VOCABULARY = {
  genre: new Set(['hard-sci-fi', 'space-opera', 'cyberpunk', 'dystopian', 'military-sci-fi', 'fantasy', 'thriller']),
  mood: new Set(['dark', 'humorous', 'hopeful', 'tense', 'meditative', 'action-driven']),
  theme: new Set(['first-contact', 'ai', 'time-travel', 'post-apocalyptic', 'political', 'survival', 'dystopian']),
  era: new Set(['golden-age', 'new-wave', 'modern', 'classic']),
  pacing: new Set(['slow-burn', 'fast-paced', 'episodic', 'dense']),
  length: new Set(['short', 'medium', 'long', 'epic']),
  audience: new Set(['adult', 'ya', 'all-ages']),
};

// ── Ollama transport ─────────────────────────────────────────────────────────

const TIMEOUT_MS = 300_000;

async function ollamaChat(url, model, system, user, format, temp) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    format,
    options: { num_predict: 4096 },
  };
  if (temp !== null) body.options.temperature = temp;
  return post(`${url}/api/chat`, body, (d) => d.message?.content ?? '');
}

async function ollamaGenerate(url, model, prompt, temp) {
  const body = { model, prompt, stream: false, format: 'json', options: {} };
  if (temp !== null) body.options.temperature = temp;
  return post(`${url}/api/generate`, body, (d) => d.response ?? '');
}

async function post(endpoint, body, pick) {
  const started = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const evalCount = data.eval_count ?? 0;
  const evalNs = data.eval_duration ?? 0;
  return {
    text: pick(data),
    wallMs: Date.now() - started,
    promptTokens: data.prompt_eval_count ?? 0,
    outputTokens: evalCount,
    tokensPerSec: evalNs > 0 ? evalCount / (evalNs / 1e9) : null,
  };
}

/** Same lenient extraction the app uses (llmClient.extractJson). */
function extractJson(text) {
  const trimmed = String(text).trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const bodyText = fence?.[1] ? fence[1].trim() : trimmed;
  const firstObj = bodyText.indexOf('{');
  const firstArr = bodyText.indexOf('[');
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const close = bodyText[start] === '{' ? '}' : ']';
  const end = bodyText.lastIndexOf(close);
  if (end <= start) return null;
  return bodyText.slice(start, end + 1);
}

function parseLenient(text) {
  const candidate = extractJson(text);
  if (candidate === null) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

// ── Graders ──────────────────────────────────────────────────────────────────

const ARTICLES = /^(the|a|an)\s+/;
function norm(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    // Apostrophes vanish rather than becoming a gap, so "Abaddon's Gate" and
    // "Abaddons Gate" compare equal; other punctuation becomes a separator.
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normLoose(s) { return norm(s).replace(ARTICLES, ''); }
function matchesAny(value, accepted) {
  const v = norm(value);
  const vl = normLoose(value);
  return accepted.some((a) => v === norm(a) || vl === normLoose(a));
}
const EMPTYISH = new Set(['', 'none', 'null', 'n a', 'na', 'unknown', 'standalone', 'no series']);
function isEmptyish(v) { return v === null || v === undefined || EMPTYISH.has(norm(v)); }

function gradeMetadata(parsed, expect) {
  const fields = {};
  if (parsed === null || typeof parsed !== 'object') {
    return { jsonValid: false, fields: { title: false, author: false, series: false, series_number: false }, score: 0 };
  }
  fields.title = matchesAny(parsed.title, expect.title);
  fields.author = matchesAny(parsed.author, expect.author);
  fields.series = expect.series === null ? isEmptyish(parsed.series) : matchesAny(parsed.series, expect.series);

  const got = parsed.series_number;
  if (expect.series_number === null) {
    // A standalone must come back with no number. Some models emit 0 to mean
    // "none" — that still counts as wrong, because the app writes 0 straight
    // through as a real sequence (librarian/index.ts parseFloat path).
    fields.series_number = got === null || got === undefined || got === '';
  } else {
    const n = typeof got === 'number' ? got : Number(String(got ?? '').trim());
    fields.series_number = Number.isFinite(n) && Math.abs(n - expect.series_number) < 1e-9;
  }
  const score = Object.values(fields).filter(Boolean).length / 4;
  return { jsonValid: true, fields, score };
}

function gradeTagging(parsed, spec) {
  const base = {
    jsonValid: false, schemaValid: false, coverage: 0, allCategories: false,
    vocabRate: 0, confidenceOk: false, mustHaveRate: 0, mustNotClean: false, score: 0,
  };
  if (parsed === null || !Array.isArray(parsed?.tags)) return base;
  base.jsonValid = true;

  const tags = parsed.tags.filter((t) => t && typeof t.tag === 'string' && typeof t.category === 'string');
  base.schemaValid = tags.length === parsed.tags.length && tags.length > 0
    && parsed.tags.every((t) => typeof t.confidence === 'number');

  const present = new Set(tags.map((t) => t.category));
  base.coverage = REQUIRED_CATEGORIES.filter((c) => present.has(c)).length / REQUIRED_CATEGORIES.length;
  base.allCategories = TAG_CATEGORIES.every((c) => present.has(c));

  const inVocab = tags.filter((t) => VOCABULARY[t.category]?.has(t.tag)).length;
  base.vocabRate = tags.length > 0 ? inVocab / tags.length : 0;
  base.confidenceOk = tags.every((t) => typeof t.confidence === 'number' && t.confidence >= 0 && t.confidence <= 1);

  const has = (cat, tag) => tags.some((t) => t.category === cat && t.tag === tag);
  base.mustHaveRate = spec.mustHave.filter(([c, t]) => has(c, t)).length / spec.mustHave.length;
  const allTagNames = new Set(tags.map((t) => t.tag));
  base.mustNotClean = !spec.mustNotHave.some((t) => allTagNames.has(t));

  // Correctness first, hygiene second.
  base.score =
    0.40 * base.mustHaveRate +
    0.20 * (base.mustNotClean ? 1 : 0) +
    0.20 * base.coverage +
    0.10 * base.vocabRate +
    0.05 * (base.allCategories ? 1 : 0) +
    0.05 * (base.confidenceOk ? 1 : 0);
  return base;
}

function gradeCollections(parsed, spec) {
  const base = { jsonValid: false, countInRange: false, groundedRate: 0, noEmpty: false, distinctBooks: 0, score: 0 };
  if (parsed === null || !Array.isArray(parsed?.collections)) return base;
  base.jsonValid = true;

  const valid = new Set(spec.summary.map((b) => b.id));
  const cols = parsed.collections.filter((c) => c && Array.isArray(c.bookIds));
  base.countInRange = cols.length >= 3 && cols.length <= 5;
  base.noEmpty = cols.length > 0 && cols.every((c) => c.bookIds.length > 0 && typeof c.name === 'string' && c.name.trim() !== '');

  const allIds = cols.flatMap((c) => c.bookIds);
  const grounded = allIds.filter((id) => valid.has(id)).length;
  base.groundedRate = allIds.length > 0 ? grounded / allIds.length : 0;
  base.distinctBooks = new Set(allIds.filter((id) => valid.has(id))).size;

  base.score =
    0.55 * base.groundedRate +
    0.20 * (base.countInRange ? 1 : 0) +
    0.15 * (base.noEmpty ? 1 : 0) +
    0.10 * Math.min(1, base.distinctBooks / Math.min(8, spec.summary.length));
  return base;
}

// ── Stats ────────────────────────────────────────────────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function pct(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const fmtPct = (x) => `${(x * 100).toFixed(0)}%`;

// ── Runner ───────────────────────────────────────────────────────────────────

async function runSuite(name, model, opts, log) {
  const results = [];
  const specs = name === 'metadata' ? CASES.metadata : name === 'tagging' ? CASES.tagging : CASES.collections;

  for (const spec of specs) {
    const runs = [];
    for (let r = 0; r < opts.repeats; r++) {
      try {
        let call, parsed, grade;
        if (name === 'metadata') {
          call = await ollamaGenerate(opts.url, model, metadataPrompt(spec.input), opts.temp);
          parsed = parseLenient(call.text);
          grade = gradeMetadata(parsed, spec.expect);
        } else if (name === 'tagging') {
          call = await ollamaChat(opts.url, model, TAG_SYSTEM, tagUserPrompt(spec.book), TAG_JSON_SCHEMA, opts.temp);
          parsed = parseLenient(call.text);
          grade = gradeTagging(parsed, spec);
        } else {
          const user = `Library summary:\n${JSON.stringify(spec.summary)}`;
          call = await ollamaChat(opts.url, model, AUTODISCOVER_SYSTEM, user, MULTI_COLLECTION_JSON_SCHEMA, opts.temp);
          parsed = parseLenient(call.text);
          grade = gradeCollections(parsed, spec);
        }
        runs.push({ ok: true, grade, wallMs: call.wallMs, tokensPerSec: call.tokensPerSec, outputTokens: call.outputTokens, raw: call.text.slice(0, 1200) });
      } catch (err) {
        runs.push({ ok: false, error: String(err.message ?? err), grade: { score: 0, jsonValid: false }, wallMs: null, tokensPerSec: null });
      }
      log(`    ${spec.id} run ${r + 1}/${opts.repeats}  score=${runs[runs.length - 1].grade.score.toFixed(2)}${runs[runs.length - 1].ok ? '' : ' ERROR'}`);
    }
    const scores = runs.map((r) => r.grade.score);
    results.push({
      caseId: spec.id,
      meanScore: mean(scores),
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
      stable: Math.max(...scores) - Math.min(...scores) < 1e-9,
      runs,
    });
  }
  return results;
}

async function warmup(url, model) {
  await post(`${url}/api/generate`, { model, prompt: 'ok', stream: false, options: { num_predict: 1 } }, (d) => d.response ?? '');
}

async function listInstalled(url) {
  const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET /api/tags -> HTTP ${res.status}`);
  const data = await res.json();
  return (data.models ?? []).map((m) => ({ name: m.name, sizeGb: m.size ? (m.size / 1e9).toFixed(1) : '?', params: m.details?.parameter_size ?? '?', quant: m.details?.quantization_level ?? '?' }));
}

function checkDrift() {
  const checks = [
    { file: 'apps/backend/src/modules/curator/core/llmClient.ts', needle: 'You are a librarian that classifies audiobooks', label: 'tagging system prompt' },
    { file: 'apps/backend/src/modules/curator/core/llmClient.ts', needle: 'You are a Master Literary Curator', label: 'auto-discover system prompt' },
    { file: 'apps/backend/src/modules/librarian/index.ts', needle: 'You are a meticulous metadata extraction assistant', label: 'metadata prompt' },
  ];
  let ok = true;
  for (const c of checks) {
    let src;
    try { src = readFileSync(join(ROOT, c.file), 'utf8'); }
    catch { console.error(`  MISSING ${c.file} — cannot verify ${c.label}`); ok = false; continue; }
    if (!src.includes(c.needle)) { console.error(`  DRIFT: ${c.label} not found in ${c.file}`); ok = false; }
    else console.log(`  ok  ${c.label}`);
  }
  return ok;
}

// ── Report ───────────────────────────────────────────────────────────────────

function report(all, opts) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# Ollama model bake-off`);
  push();
  push(`- Endpoint: \`${opts.url}\``);
  push(`- Repeats per case: ${opts.repeats}`);
  push(`- Temperature: ${opts.temp === null ? 'model default (matches production)' : opts.temp}`);
  push(`- Suites: ${opts.suites.join(', ')}`);
  push();

  push(`## Summary`);
  push();
  push(`| Model | ${opts.suites.map((s) => `${s} score`).join(' | ')} | p50 latency | p95 latency | tok/s | unstable cases |`);
  push(`|---|${opts.suites.map(() => '---').join('|')}|---|---|---|---|`);
  for (const [model, suites] of Object.entries(all)) {
    const every = Object.values(suites).flat();
    const lat = every.flatMap((c) => c.runs.map((r) => r.wallMs).filter((x) => x !== null));
    const tps = every.flatMap((c) => c.runs.map((r) => r.tokensPerSec).filter((x) => x));
    const unstable = every.filter((c) => !c.stable).length;
    const cells = opts.suites.map((s) => (suites[s] ? fmtPct(mean(suites[s].map((c) => c.meanScore))) : '—'));
    push(`| \`${model}\` | ${cells.join(' | ')} | ${(pct(lat, 50) / 1000).toFixed(1)}s | ${(pct(lat, 95) / 1000).toFixed(1)}s | ${mean(tps).toFixed(0)} | ${unstable}/${every.length} |`);
  }
  push();

  for (const suite of opts.suites) {
    push(`## ${suite} — per case`);
    push();
    const ids = (CASES[suite] ?? []).map((c) => c.id);
    push(`| Case | ${Object.keys(all).map((m) => `\`${m}\``).join(' | ')} |`);
    push(`|---|${Object.keys(all).map(() => '---').join('|')}|`);
    for (const id of ids) {
      const cells = Object.values(all).map((suites) => {
        const c = (suites[suite] ?? []).find((x) => x.caseId === id);
        if (!c) return '—';
        return `${fmtPct(c.meanScore)}${c.stable ? '' : ` (${fmtPct(c.minScore)}–${fmtPct(c.maxScore)})`}`;
      });
      push(`| ${id} | ${cells.join(' | ')} |`);
    }
    push();

    if (suite === 'metadata') {
      push(`### metadata — field accuracy`);
      push();
      push(`| Model | title | author | series | series_number | JSON parse |`);
      push(`|---|---|---|---|---|---|`);
      for (const [model, suites] of Object.entries(all)) {
        const runs = (suites.metadata ?? []).flatMap((c) => c.runs).filter((r) => r.ok);
        const f = (k) => fmtPct(mean(runs.map((r) => (r.grade.fields?.[k] ? 1 : 0))));
        push(`| \`${model}\` | ${f('title')} | ${f('author')} | ${f('series')} | ${f('series_number')} | ${fmtPct(mean(runs.map((r) => (r.grade.jsonValid ? 1 : 0))))} |`);
      }
      push();
    }
    if (suite === 'tagging') {
      push(`### tagging — sub-metrics`);
      push();
      push(`| Model | must-have hit | no forbidden tag | required-cat coverage | all 7 cats | in-vocabulary | confidence in range |`);
      push(`|---|---|---|---|---|---|---|`);
      for (const [model, suites] of Object.entries(all)) {
        const runs = (suites.tagging ?? []).flatMap((c) => c.runs).filter((r) => r.ok);
        const m = (fn) => fmtPct(mean(runs.map(fn)));
        push(`| \`${model}\` | ${m((r) => r.grade.mustHaveRate)} | ${m((r) => (r.grade.mustNotClean ? 1 : 0))} | ${m((r) => r.grade.coverage)} | ${m((r) => (r.grade.allCategories ? 1 : 0))} | ${m((r) => r.grade.vocabRate)} | ${m((r) => (r.grade.confidenceOk ? 1 : 0))} |`);
      }
      push();
    }
    if (suite === 'collections') {
      push(`### collections — grounding`);
      push();
      push(`| Model | grounded book IDs | 3–5 collections | no empty collection | distinct books used |`);
      push(`|---|---|---|---|---|`);
      for (const [model, suites] of Object.entries(all)) {
        const runs = (suites.collections ?? []).flatMap((c) => c.runs).filter((r) => r.ok);
        const m = (fn) => fmtPct(mean(runs.map(fn)));
        push(`| \`${model}\` | ${m((r) => r.grade.groundedRate)} | ${m((r) => (r.grade.countInRange ? 1 : 0))} | ${m((r) => (r.grade.noEmpty ? 1 : 0))} | ${mean(runs.map((r) => r.grade.distinctBooks)).toFixed(1)} |`);
      }
      push();
    }
  }

  const errors = Object.entries(all).flatMap(([m, s]) => Object.values(s).flat().flatMap((c) => c.runs.filter((r) => !r.ok).map((r) => `- \`${m}\` ${c.caseId}: ${r.error}`)));
  if (errors.length) { push(`## Errors`); push(); push(...errors); push(); }

  return lines.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.checkDrift) {
    console.log('Checking prompt copies against app source...');
    process.exit(checkDrift() ? 0 : 1);
  }

  if (!opts.models.length) {
    console.error('No --models given.\n');
    try {
      const installed = await listInstalled(opts.url);
      console.error(`Installed at ${opts.url}:`);
      for (const m of installed) console.error(`  ${m.name.padEnd(32)} ${m.params.padEnd(8)} ${m.quant.padEnd(8)} ${m.sizeGb}GB`);
    } catch (err) {
      console.error(`Could not reach Ollama at ${opts.url}: ${err.message}`);
      console.error(`Set OLLAMA_URL or pass --url.`);
    }
    console.error('');
    usage();
    process.exit(2);
  }

  console.log(`Ollama: ${opts.url}`);
  console.log(`Prompt drift check:`);
  checkDrift();
  console.log('');

  const all = {};
  for (const model of opts.models) {
    console.log(`\n=== ${model} ===`);
    process.stdout.write('  warming up... ');
    try { await warmup(opts.url, model); console.log('done'); }
    catch (err) { console.log(`FAILED: ${err.message}`); all[model] = {}; continue; }

    all[model] = {};
    for (const suite of opts.suites) {
      console.log(`  [${suite}]`);
      all[model][suite] = await runSuite(suite, model, opts, (s) => console.log(s));
    }
  }

  mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const md = report(all, opts);
  const mdPath = join(opts.out, `bench-${stamp}.md`);
  const jsonPath = join(opts.out, `bench-${stamp}.json`);
  writeFileSync(mdPath, md, 'utf8');
  writeFileSync(jsonPath, JSON.stringify({ opts, results: all }, null, 2), 'utf8');

  console.log('\n' + md);
  console.log(`\nWrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}   (full raw responses for eyeballing failures)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
