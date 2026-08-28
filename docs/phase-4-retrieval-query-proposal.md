# Phase 4 retrieval acceptance query proposal

Status: **awaiting user approval or modification**.

These ten queries are the proposed human-authored regression set for
`librarian-engine-plan.md` §10.C step 7. They deliberately cover free-form
semantic retrieval, tag re-ranking, duration and series constraints, hard
negative filters, trusted positive evidence, and publication-year filters.

The acceptance harness ultimately needs real `bookId` values and query vectors.
This workspace does not contain a usable Curator snapshot: the local
`apps/backend/data/curator.db` contains ingest-job tables only. Therefore the
expected results below are review criteria, not invented IDs. After approval,
resolve the approved titles against a distinct read-only snapshot and encode
them as `topBookIds`, `includesInTopK`, and `excludesFromTopK`.

## Proposed queries and expected results

### Q1 — Key West beach mystery

**User wording:** “I’m in the mood for a murder mystery at the beach — sunny,
coastal, and more mystery than thriller.”

**Retrieval intent:** semantic query `murder mystery at the beach`; prefer
`genre:mystery` and coastal/beach settings; softly demote `genre:thriller`.

**Expected result:** a **Key West Capers** title is rank 1. Other Key West
Capers titles may follow when equally relevant. No hard-science-fiction or
space-opera title appears above the first Key West Capers result.

**Approval needed:** identify the Key West Capers title that should be the
exact rank-1 regression target, plus any sibling titles that must appear in the
top 5.

### Q2 — Melancholic coastal autumn

**User wording:** “Give me autumn in an old coastal town: melancholic and cozy,
with a little mystery, but not a full-on thriller.”

**Retrieval intent:** semantic query `melancholic cozy coastal autumn mystery`;
prefer `mood:melancholic`, `mood:cozy`, `setting:coastal-town`,
`setting:small-town`, and `theme:mystery`; softly demote `genre:thriller`.

**Expected result:** rank 1 should match the coastal/autumn atmosphere and at
least one of melancholic or cozy. The top 3 should contain no action-driven
thriller that lacks the requested atmosphere. A book matching all three core
facets—coastal, autumn, melancholic/cozy—must outrank a book matching only one.

**Approval needed:** choose the owned title that best represents this vibe and
should be the exact rank-1 target.

### Q3 — The Expanse qualities, moved into fantasy

**User wording:** “I want the world-building and political intrigue of The
Expanse, but as low-stakes fantasy with smart dialogue and an ensemble cast.”

**Retrieval intent:** require `genre:fantasy`; prefer `theme:political`,
`structure:multi-pov`, `trope:found-family`, `mood:humorous`, and `mood:cozy`.
Hard-exclude `genre:hard-sci-fi` and `genre:space-opera`; the prose carries the
world-building and smart-dialogue transfer.

**Expected result:** the top result is an owned fantasy title with political or
ensemble structure and a lower-stakes tone. The Expanse itself and other
hard-science-fiction/space-opera titles do not appear in the top 10. A generic
cozy fantasy without political/ensemble evidence should not outrank a title
that carries those transferable qualities.

**Approval needed:** choose the best owned fantasy analogue and any acceptable
alternates for the top 5.

### Q4 — Commute-safe and easy to resume

**User wording:** “Something fast and punchy for a 45-minute commute, under 12
hours, and easy to pick back up after a 30-second zone-out.”

**Retrieval intent:** hard maximum duration of 12 hours; require or strongly
prefer `pacing:fast-paced`; prefer `structure:linear`,
`structure:single-pov`, and `length:short|medium`.

**Expected result:** every top-10 result is 12 hours or shorter. Rank 1 is
fast-paced and has linear or single-POV evidence. A longer book never survives
the hard filter, regardless of semantic similarity. No expectation is based on
chapter duration because that data is not available.

**Approval needed:** choose one or more books you personally consider genuinely
easy to resume during a commute.

### Q5 — Guardrailed space opera

**User wording:** “I want sprawling political space opera, but absolutely no
time travel and no chosen-one plot. Prefer hard magic or technology with real
rules.”

**Retrieval intent:** require or strongly prefer `genre:space-opera`; prefer
`theme:political`, `structure:multi-pov`, and `trope:hard-magic`; hard-exclude
the unqualified `time-travel` tag (regardless of whether existing data
classified it as theme or trope) and `trope:chosen-one` from every provenance.

**Expected result:** every top-10 result survives both hard exclusions. Rank 1
is a long or epic political space opera when the library contains one. Any book
known to contain time travel or a chosen-one plot is encoded in
`excludesFromTopK`, even if its semantic score is otherwise excellent.

**Approval needed:** choose the best safe rank-1 title and list any known
time-travel/chosen-one books that must be explicit negative controls.

### Q6 — Trusted time-travel evidence

**User wording:** “A clever, serious time-travel story about causality and
consequences—not a romance wearing a time-machine costume.”

**Retrieval intent:** require the unqualified `time-travel` tag with
`trustedOnly:true` so both legacy theme and trope classifications are covered;
prefer `structure:nonlinear`, `pacing:dense`, and `mood:meditative`; softly
demote romance-oriented candidates.

**Expected result:** the top results have trusted positive time-travel evidence.
A book whose only time-travel tag is untrusted `llm-open` evidence does not
qualify. Rank 1 should substantially concern causality/consequences rather than
using time travel as incidental scenery.

**Approval needed:** choose the strongest owned example and identify an
untrusted-only or incidental-time-travel negative control if one exists.

### Q7 — Hopeful post-apocalyptic survival

**User wording:** “Post-apocalyptic survival that ultimately feels hopeful and
human, not relentlessly bleak.”

**Retrieval intent:** require `theme:post-apocalyptic`; prefer
`theme:survival`, `mood:hopeful`, and `trope:found-family`; softly demote
`mood:dark` and `mood:tense` rather than banning them.

**Expected result:** rank 1 is recognizably post-apocalyptic and survival-led,
but has hopeful, community, or found-family evidence. A relentlessly bleak
book may remain in the top 10 if otherwise relevant, but should rank below a
comparably relevant hopeful candidate.

**Approval needed:** choose the owned title that best captures “hopeful and
human,” plus any famous bleak title that should act as a relative-ordering
control.

### Q8 — Thoughtful first contact or AI

**User wording:** “A thoughtful first-contact or AI story that is more
meditative than action-driven, with big ideas I can sit with.”

**Retrieval intent:** require any of `theme:first-contact` or `theme:ai`;
prefer `mood:meditative`, `pacing:slow-burn`, and `pacing:dense`; softly demote
`mood:action-driven`.

**Expected result:** every top result is grounded in first contact or AI. Rank 1
prioritizes philosophical/meditative treatment over military or action-led
treatment. A generic space opera lacking either required theme does not appear
in the top 10.

**Approval needed:** choose the most thoughtful owned example and one
action-heavy negative/relative-ordering control.

### Q9 — Funny found-family fantasy without chosen-one

**User wording:** “A funny found-family fantasy under 15 hours, and please no
chosen-one destiny.”

**Retrieval intent:** require `genre:fantasy`; hard maximum duration 15 hours;
hard-exclude `trope:chosen-one`; prefer `mood:humorous` and
`trope:found-family`.

**Expected result:** every top-10 result is fantasy, 15 hours or shorter, and
not tagged chosen-one. Rank 1 carries both humorous and found-family evidence
when such a book exists. A chosen-one fantasy is an explicit
`excludesFromTopK` control.

**Approval needed:** choose the preferred rank-1 title and at least one known
chosen-one fantasy to encode as a negative control.

### Q10 — Classic standalone science fiction

**User wording:** “A standalone classic science-fiction novel from before 1980:
idea-driven, not military, and not the start of a giant series.”

**Retrieval intent:** publication year through 1979; `series:standalone`;
require any of `genre:hard-sci-fi` or an approved general science-fiction tag;
prefer `era:classic|golden-age`, `pacing:dense`, and `mood:meditative`; softly
demote `genre:military-sci-fi`.

**Expected result:** every top result is published before 1980 and is
standalone according to the mirror. Rank 1 is idea-driven rather than
military/action-led. Any later publication or in-series volume is excluded by
construction, not merely ranked lower.

**Approval needed:** choose the desired classic rank-1 title and confirm whether
1979 is the intended cutoff.

## Approval checklist

For each query, approve or modify:

1. the natural-language wording;
2. hard constraints versus soft preferences;
3. the exact rank-1 title;
4. additional titles that must appear somewhere in the top 5 or top 10;
5. explicit titles that must not appear in the top 10.

Once approved and a consistent snapshot is available, the mechanical follow-up
is:

1. resolve approved titles to snapshot book IDs;
2. generate each query vector with the snapshot's configured embedding model;
3. encode the assertions in
   `scripts/fixtures/retrieval-acceptance-queries.v1.json`;
4. run the snapshot-only harness across the three weight sets;
5. present disagreements for human judgment rather than changing expectations
   to match the current output.
