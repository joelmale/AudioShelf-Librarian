# Audio Transcript Pipeline — Deferred Plan

**Status: parked. Do not start before `docs/librarian-engine-plan.md` Phase 6
is complete.** This document exists so the design decisions reached on
2026-08-26 are not re-derived from memory later.

Goal: raise **entity coverage** on books no catalogue describes, by deriving
characters, places, and (eventually) mood/theme signal from the audio itself.

---

## 0. Why this exists, and why it is not urgent

Entity coverage sat at **298 of 961 books (31%)** when this was written. The
covered books are overwhelmingly classics and long-tail-catalogued titles —
`A Clash of Kings`, `2001: A Space Odyssey`, `A Clockwork Orange` — because
Open Library's `person`/`place`/`time` fields come from library-contributed
MARC headings. Recent genre and indie fiction has bare stub records, so the
663 uncovered books are structurally uncoverable from that source.

Google Books, added 2026-08-25, does **not** close this gap. Its API exposes
no structured person/place/time fields at all; the provider returns
`entities: []` by design. It improves `subjects`, not entities.

So the audio is the only remaining first-party source of truth for those 663.

**But it is the last resort, not the first.** Three cheaper sources must be
exhausted and *measured* first — see §7. If the description extractor alone
lifts coverage from 31% to 70%, the remaining set may be small enough that
this pipeline is never worth building. Deciding that with a number rather
than a guess is the entire point of the sequencing.

---

## 1. The rule this design exists to enforce

> **Transcription is the expensive, immutable step. Extraction is the cheap
> step whose rules will change ten times.**

Everything below follows from that separation. It is the same lesson
`external_metadata` already encodes — payloads are cached verbatim so that
improving the entity extractor costs nothing — applied to a step that is
four orders of magnitude more expensive to repeat.

Concretely:

1. A transcript, once produced, is **never mutated and never deleted** by
   any derivation step.
2. Re-transcribing with a better model **adds a row**; it does not overwrite
   one. The store is append-only and content-addressed by
   `(book_id, model, sample_plan_hash)`.
3. Nothing derived from a transcript is stored in the same table as the
   transcript.
4. Any extractor must be re-runnable against the existing store with **zero
   GPU time**. If a proposed change to extraction requires re-transcribing,
   that is a design error in the extractor, not a cost to accept.

---

## 2. Sample, do not transcribe whole books

This is the decision that makes the project affordable, and it is
deliberate rather than a compromise.

For a **cast list**, full transcription is enormous overkill. Principal
characters are introduced early and named repeatedly. A book's opening plus
a handful of later spot-checks captures nearly the whole principal cast.

**The sample plan (v1):**

| Segment | Offset | Length |
|---|---|---|
| Opening | 0:00 | 30 min |
| Spot 1 | 25% of duration | 5 min |
| Spot 2 | 45% | 5 min |
| Spot 3 | 65% | 5 min |
| Spot 4 | 85% | 5 min |

≈ **50 minutes per book** instead of a ~11h average.

Offsets are *fractional*, so the plan is duration-independent and
reproducible. The plan itself is hashed into `sample_plan_hash` so a future
change to the plan is a new row rather than a silent inconsistency — two
books transcribed under different plans must never be compared as if they
were the same measurement.

**Cost is in §3.2**, because it depends entirely on the card. The short
version on the actual hardware (RTX A2000 6 GB): sampling turns a **2.5–6
week** job into a **1.3–3.3 day** one. That is the difference between a
project and a non-starter.

Both figures assume a ~11h average duration — *measure it first*, see §7.0.
Extraction with `ffmpeg -ss` is a seek-and-copy, not a full decode, so
producing the samples is cheap relative to the ASR itself.

**What sampling cannot give**, and therefore what is explicitly out of scope
for v1: mood/tension arc over time, character screen-time, relationship
graphs, and per-chapter pacing. Those genuinely need the whole text. They
are a *different project* with a different cost justification, and bundling
them here is how a 2-day job becomes a 3-week one. See §8.

---

## 3. Hardware reality (verified 2026-08-26)

| Fact | Value | How known |
|---|---|---|
| CPUs | 48 | `get_host_info` on HomePod |
| RAM | ~24 GB | same |
| GPU | **NVIDIA RTX A2000, 6 GB** | DCGM exporter, driver 595.71.05 |
| VRAM free at rest | 5796 MB free / 3 MB used | `DCGM_FI_DEV_FB_FREE` / `_FB_USED` |
| Local inference | Ollama running | `ollama/ollama:latest` container |

**The A2000 6 GB is the binding constraint, and it is the reason §2's
sampling decision is not optional.** This is an entry-level Ampere
workstation card (~70 W, 192-bit bus, 3328 CUDA cores) — roughly a third to
a quarter of a 3090-class card for this workload.

### 3.1 VRAM forces the model choice, and the choice is not free

| Model | Precision | Approx. VRAM | Coexists with Ollama? |
|---|---|---|---|
| `large-v3` | float16 | ~4.7 GB | **No** — leaves ~1 GB |
| `large-v3` | int8_float16 | ~2 GB | Yes, with a small model |
| `distil-large-v3` | int8 | ~1.5 GB | Comfortably |
| `medium` | int8 | ~1 GB | Comfortably |

The trap: **int8 quantization degrades rare-token accuracy most, and rare
tokens are exactly invented proper nouns** — the one accuracy axis this
pipeline cares about (§4). "Shrink the model until it fits" therefore trades
directly against the thing the project exists to get right. That tension is
what T0 must resolve with a measurement, not a preference.

`FB_USED` was 3 MB when sampled, i.e. Ollama had idled out and unloaded. That
is the ceiling at rest, not a guarantee of headroom during a run.

### 3.2 Revised cost estimate

Throughput on this card is **unmeasured**. Expect single-digit to low-double-digit
realtime for `large-v3`, better for distilled/quantized variants. Treating
that as a range rather than a number:

| Approach | Audio hours | @ ~10× (large-v3) | @ ~25× (distil int8) |
|---|---|---|---|
| Full transcription | ~10,500 | ~1,050 GPU-h → **~6 weeks** | ~420 GPU-h → **~2.5 weeks** |
| Sampled (~50 min/book) | ~800 | ~80 GPU-h → **~3.3 days** | ~32 GPU-h → **~1.3 days** |

Full transcription on this hardware is not a 3-week job, it is a 2.5–6 week
job on a *contended* GPU. It is off the table for v1 on cost grounds alone,
independent of the scope argument in §8.

### 3.3 The CPU option is genuinely competitive here

With 48 cores, `faster-whisper` int8 **on CPU** runs perhaps 1–3× realtime
per worker; 8 parallel workers gives aggregate throughput in the same range
as this particular GPU, while leaving the GPU entirely to Ollama.

On a larger card this would be a silly trade. On an A2000 6 GB that is
already shared, it may be the better engineering choice — it removes the
contention problem in §3.4 completely rather than managing it. **T0 must
benchmark both**, and the runner interface should not assume a device.

### 3.4 Contention needs a lease, not a schedule

The earlier note said "schedule off-peak". That is too weak given 6 GB:
Whisper at ~2 GB plus Ollama loading a chat model does not fit, and the
failure mode is a CUDA OOM mid-run rather than graceful slowness.

If the GPU path is chosen, the honest design is a **single GPU lease held by
at most one operation at a time** across the app — transcription, and any
future GPU-bound work, take turns rather than overlap. The operation is
pausable via `OperationController` regardless, but pausability is a recovery
mechanism, not a concurrency policy.

---

## 4. The risk that dominates this design

**ASR mangles invented proper nouns, and `book_entities` is a grounding
allowlist — not a display field.**

The uncovered 663 are largely SF/fantasy, i.e. exactly the worst case:
*Rhysand, Feyre, Tamlin, Azriel, Nesta Archeron* come back as "Reesand",
"Fay-ruh", "Azrial". This matters more here than in a generic NER pipeline
because of what consumes the table:

- `tagging/ground.ts` uses `book_entities` to decide which entity tags are
  legitimate. Hallucinated names would let the grounding layer bless tags
  built on nothing — inverting the exact mechanism Phase 1 shipped to *stop*
  hallucination (`Adrian Dover` → dropped).
- `entityNotability.ts` scores notability from library-wide frequency.
  Flooding it with thousands of near-miss spellings distorts
  `libraryFrequency`/`librarySize` for **every** book, including the 298
  that are currently correct.

Empty coverage is honest. Confidently wrong coverage is the same class of
failure as a `0%` that means "never checked" — invariant 5 in
`docs/phase-4-readiness.md`, and the reason the M4B metric and the
structure metric both report `Unknown` today.

**Mitigations, in descending order of trust:**

1. **Corroboration.** Cross-check every ASR-derived name against a trusted
   source already cached — the Google Books / Audnexus description, Open
   Library `person`. A name in both is solid.
2. **Provenance, using the existing column.** `book_entities.sources` is
   already a JSON array. ASR-only entities get `sources: ["transcript"]`,
   and grounding weights them below catalogue-confirmed ones. No schema
   change needed; the design anticipated this.
3. **Frequency thresholding.** A real character is spoken hundreds of times
   across the sample; a mis-hear is usually a one-off. Cheap, effective,
   deterministic.
4. **Snap-to-known.** Feed the extractor the known-good names from the
   cached description as context, so it can resolve "Reesand" → "Rhysand"
   rather than inventing a second character.

**Gate:** an ASR-only entity with no corroboration and low frequency is
recorded but **not promoted into the grounding allowlist**. It is a
candidate, visible in the UI as such, until something confirms it. The
allowlist's precision is worth more than its recall.

---

## 5. Data layer

Two tables. The separation between them is the point (§1).

```sql
-- IMMUTABLE. Append-only. Never updated in place, never deleted by a
-- derivation step. A better model or a changed sample plan writes a NEW row.
CREATE TABLE book_transcripts (
  book_id           TEXT NOT NULL,
  model             TEXT NOT NULL,   -- 'faster-whisper:distil-large-v3'
  sample_plan_hash  TEXT NOT NULL,   -- hash of the §2 offsets/lengths
  text              TEXT NOT NULL,   -- concatenated segment text
  segments          TEXT NOT NULL,   -- JSON: [{start,end,text}] per sample
  audio_duration_s  INTEGER NOT NULL,
  sampled_s         INTEGER NOT NULL,-- how much audio was actually heard
  transcribed_at    INTEGER NOT NULL,
  PRIMARY KEY (book_id, model, sample_plan_hash)
);

-- DERIVED. Freely rebuilt from book_transcripts with zero GPU cost.
CREATE TABLE transcript_entities (
  book_id     TEXT NOT NULL,
  entity      TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- 'person' | 'place' | 'time'
  mentions    INTEGER NOT NULL,-- frequency across the sample
  corroborated INTEGER NOT NULL DEFAULT 0, -- 0|1 — confirmed by a catalogue
  extractor_version INTEGER NOT NULL,
  PRIMARY KEY (book_id, entity, kind)
);
```

`sampled_s` vs `audio_duration_s` is the invariant-5 field: it records what
was actually heard, so nothing downstream can present a 50-minute sample as
if the whole book had been read. A book with no row at all is `Unknown`,
never "no characters".

**Word-level timestamps are deliberately excluded.** They multiply storage
roughly 10× (~5–10 GB across the library vs ~700 MB of segment text) and
entity extraction does not use them. Add them only if a feature that needs
them — "jump to where this character first appears" — is actually being
built.

---

## 6. Pipeline

```
[m4b/mp3 on disk]
      │  ffmpeg -ss (seek+copy, per §2 plan)
      ▼
[5 audio samples, ~50 min total]
      │  faster-whisper / WhisperX, VAD on
      ▼
[book_transcripts row]  ◄── IMMUTABLE BOUNDARY. Everything above is expensive
      │                     and runs once. Everything below is cheap and
      │                     re-runnable.
      ▼
[candidate names: cheap NER or capitalized-token frequency]
      │
      ▼
[ONE LLM pass per book: canonicalize, resolve aliases, drop junk,
 snap to known names from the cached description]
      ▼
[transcript_entities]
      │  corroboration + frequency gate (§4)
      ▼
[book_entities, sources:["transcript"] or ["transcript","openlibrary"]]
```

**On LLM volume.** An earlier sketch proposed a structured-extraction call
per ~2k-token chunk — ~50 calls/book, ~48,000 across the library. Rejected.
Run the cheap deterministic pass first (frequency over capitalized tokens,
or spaCy NER), then **one or two** LLM calls per book to canonicalize the
candidate list. Two orders of magnitude cheaper, and it confines the LLM to
the part it is genuinely better at — alias resolution and pronoun binding —
rather than re-reading text a counter can handle.

**Operational shape:** clone `enricher.ts` exactly, as everything else in
this codebase does. `p-limit` pool, `OperationController` checkpoints
(pause/cancel — mandatory here given GPU contention), `dryRun`, `sample`
mode, per-book failure isolation, action-log events, `sync_log` entry with
`kind: 'transcribe'`. Concurrency defaults to **1**: this is GPU-bound, and
`encodeConcurrency` already sets that precedent for CPU-bound work.

---

## 7. Sequencing — cheaper things first

**Nothing in §5/§6 should be built until these three are done and
measured.** Each needs no GPU, and each may make the pipeline unnecessary.

**7.0 Measure the baseline.** `books.durationSeconds` is already synced —
one query gives the real duration distribution and replaces the ~11h
assumption in §2. Also confirm GPU model/VRAM (§3).

**7.1 Description extractor.** Cached `external_metadata` payloads already
hold 900–2,700 char descriptions from Google Books and ~1,300 char
summaries from Audnexus. One LLM call per book, ~961 total, trivial through
Haiku. Names protagonists and setting for most modern fiction.
**Measure the coverage lift before proceeding.**

**7.2 Chapter titles via ffprobe.** Already shipped for the encoder. M4B
chapter titles frequently *are* character names ("Chapter 12: Rhysand").
Free, instant, and publisher-authored — high precision, no hallucination
risk. Note §10.G of the librarian plan: chapter data is expanded-only from
ABS, but this reads the **local file**, not the ABS payload, so that
objection does not apply.

**7.3 Embedded file tags.** `comment`/`description` fields often carry the
publisher blurb even where no catalogue matched.

Only books still empty after 7.1–7.3 are candidates for transcription. That
set is expected to be far smaller than 663 — and if it is not, that itself
is the evidence that justifies the GPU spend.

---

## 8. Explicitly out of scope for v1

Recorded so they are not smuggled in later without a fresh cost decision:

- **Mood / tension arc over time.** Needs full transcription.
- **Character screen-time and relationship graphs.** Same.
- **Per-chapter pacing.** Same, and see §10.G of the librarian plan for why
  chapter-derived metrics have already been refused once.
- **Word-level timestamps.** §5.
- **Re-embedding from transcripts.** A transcript is a much richer embedding
  source than the current tag-and-blurb `bookCard`, and this is genuinely
  promising — but it changes `card_hash` for every transcribed book and
  would trigger a full re-embed. Worth doing; worth doing *deliberately*,
  as its own change.

---

## 9. Phase map

| Phase | Ships | Exit criterion |
|---|---|---|
| **T0. Measure** | Duration distribution query; realtime-factor benchmark on 3 known books across **both** device paths (§3.3) and three model tiers (§3.1) | §3.2's ranges are replaced with measured numbers, and the model choice is justified by **proper-noun** accuracy on known casts (Rhysand/Feyre/Azriel), not general WER |
| **T1. Cheap sources** | §7.1 description extractor, §7.2 chapter-title miner, §7.3 file tags | Coverage lift reported per source; the residual uncovered set is a known number |
| **T2. Transcript store** | Migration; `book_transcripts`; ffmpeg sampler; faster-whisper runner as an `OperationController` operation | 20-book sample run; every row carries honest `sampled_s`; re-running produces **zero** new rows (idempotent by content key) |
| **T3. Extraction** | Candidate NER + single-call canonicalizer → `transcript_entities` | Re-running extraction over the T2 store consumes **zero GPU time**; extractor_version bump rebuilds cleanly |
| **T4. Grounding integration** | Corroboration + frequency gate; `sources:["transcript"]`; notability guard | On a hand-checked 20-book set: no uncorroborated ASR name enters the grounding allowlist, and the 298 already-correct books' notability scores are unchanged |

T4's exit criterion is the one that matters. If it cannot be met, the
pipeline ships as a *candidate* surface only and never feeds grounding.

---

## 10. Testing discipline

Per AGENTS.md, and no different here:

- **No test invokes Whisper or touches audio.** The ASR step is injected
  behind an interface, exactly as `fetchImpl` is for providers and
  `MessageCreator` is for LLMs. Fixtures are recorded transcript JSON.
- **The sampler is tested against durations, not files** — given
  `audio_duration_s`, assert the computed offsets, including the edge cases:
  a book shorter than 30 min (opening only, `sampled_s == duration`), and a
  book so short the spot samples overlap.
- **Name-mangling is a first-class fixture.** Feed a transcript containing
  "Reesand"/"Rice and" alongside a cached description containing "Rhysand"
  and assert the snap-to-known resolves it — and, in the negative direction,
  that an uncorroborated one-off name does **not** reach `book_entities`.
- **Immutability is asserted directly:** re-running T2 over an already
  transcribed book writes no row; changing the sample plan writes a new row
  and leaves the old one byte-identical.

---

## 11. Open questions

**Resolved 2026-08-26:** GPU is an RTX A2000 6 GB (§3). That answer
tightened the plan rather than unblocking it — see §3.1–§3.4.

- **GPU or CPU?** (§3.3) The 48-core CPU path may beat a contended 6 GB card
  *and* removes the contention problem entirely. T0 benchmarks both. The
  runner interface must not assume a device.
- **Model tier vs proper-noun accuracy** — the question is now sharper than
  "which model is faster". On 6 GB, fitting alongside Ollama means int8, and
  int8 degrades rare-token accuracy most, i.e. exactly invented proper nouns
  (§3.1, §4). Benchmark `large-v3 int8_float16` vs `distil-large-v3 int8` vs
  `medium int8` on **proper-noun accuracy specifically, not general WER** —
  a general WER win means nothing if it comes from common words.
- **Where does ASR run?** A sidecar container with device access, or
  in-process? A sidecar isolates the CUDA/CPU-BLAS dependency from the Node
  app and can be stopped independently — likely right, and more clearly right
  if the GPU path wins, since the lease in §3.4 needs something to hold.
- **What holds the GPU lease?** (§3.4) If the GPU path is chosen, something
  must arbitrate between transcription and Ollama. Simplest honest option: a
  single-slot lease in the operations layer that any GPU-bound operation must
  acquire. Worth designing only after T0 says the GPU path won.
- **Does the ABS library path always resolve?** `absLibraryPath` is
  configured and the encoder already reads from it, so this is likely a
  non-issue, but transcription needs the *actual file* for every candidate
  book and the encoder's scanner has already had to work around ABS payload
  gaps once.
