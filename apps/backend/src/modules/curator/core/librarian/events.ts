/**
 * The librarian's SSE event vocabulary (librarian engine plan §8.1, readiness
 * item E).
 *
 * §8.1 names six events (`interpretation | action | pile | answer | audit |
 * token`) as "a public contract that tests assert against" but only spells
 * out the wire shape for two of them (`action`, `pile`); the rest are prose
 * ("the parsed query intent", "final recommendations with per-book
 * evidence", …). This file turns all eight (those six, plus the two this
 * readiness item adds) into one typed, Zod-validated discriminated union.
 *
 * The four events this item's round-loop spine (`conversation.ts`) does NOT
 * emit — `interpretation` (§8.2 query-interpretation chips), `audit` (§5.4/
 * §8.6 coverage disclosures scoped to an actual candidate set), and `token`
 * (streamed prose from a real LLM driver) — still get real shapes here
 * rather than placeholders, because a later phase (the LLM-backed
 * `TurnDriver`, chips, persistence) needs the contract to already exist. Per
 * this item's brief, their fields are kept to what §8.1's neighbouring
 * sections (§8.2, §8.5, §8.6, §5.4) actually describe — nothing invented
 * beyond that.
 */
import { z } from 'zod';

// ── existing six (§8.1) ─────────────────────────────────────────────────────

/**
 * One query-interpretation chip (§8.2): a parsed facet of the user's prose,
 * rendered as an editable chip before anything runs. `kind` distinguishes a
 * plain preference (`mood: melancholic`) from a soft demotion
 * (`soft-avoid: thriller`) or a hard exclusion (`EXCLUDE: chosen-one`) — the
 * visual distinction §8.2 calls for (tint vs. struck-through red).
 */
export const interpretationChipKindSchema = z.enum(['prefer', 'soft-avoid', 'exclude']);
export type InterpretationChipKind = z.infer<typeof interpretationChipKindSchema>;

export const interpretationChipSchema = z.object({
  category: z.string(),
  value: z.string(),
  kind: interpretationChipKindSchema,
});
export type InterpretationChip = z.infer<typeof interpretationChipSchema>;

export const interpretationEventSchema = z.object({
  type: z.literal('interpretation'),
  chips: z.array(interpretationChipSchema),
});
export type InterpretationEvent = z.infer<typeof interpretationEventSchema>;

/** One tool call (§8.1, §8.3). `detail`/`resultSummary` are curated
 *  server-side digests — "never raw JSON args" (§8.3) — not the tool's raw
 *  input/output. */
export const actionEventSchema = z.object({
  type: z.literal('action'),
  tool: z.string(),
  label: z.string(),
  detail: z.string(),
  resultSummary: z.string(),
});
export type ActionEvent = z.infer<typeof actionEventSchema>;

/** Candidate-set diff (§8.1, §8.4). A book slides into the browsing pile
 *  when a search adds it, and out with a reason chip when a filter drops it
 *  ("22h — too long for a commute"). */
export const pileRemovalSchema = z.object({
  bookId: z.string(),
  reason: z.string(),
});
export type PileRemoval = z.infer<typeof pileRemovalSchema>;

export const pileEventSchema = z.object({
  type: z.literal('pile'),
  added: z.array(z.string()),
  removed: z.array(pileRemovalSchema),
});
export type PileEvent = z.infer<typeof pileEventSchema>;

/**
 * One recommendation (§8.5). The librarian is library-only: every pick has
 * an owned-shelf `bookId`. `title`/`author` are optional display fields
 * hydrated from retrieved book cards, never a route for external results.
 * `reason` is "the reason sentence the librarian gave, verbatim" (§8.5) —
 * the evidence-panel fields (matched tags by trust tier, similarity bar,
 * shared entities) are real UI/ranking work for a later phase, not
 * something this round-loop spine can honestly populate yet.
 */
export const answerRecommendationSchema = z.object({
  bookId: z.string(),
  title: z.string().optional(),
  author: z.string().optional(),
  reason: z.string(),
});
export type AnswerRecommendation = z.infer<typeof answerRecommendationSchema>;

export const librarianAnswerSchema = z.object({
  recommendations: z.array(answerRecommendationSchema),
});
/** The payload a `TurnDriver` hands back on `{ kind: 'answer' }` (see
 *  conversation.ts), and what an `answer` event carries. */
export type LibrarianAnswer = z.infer<typeof librarianAnswerSchema>;

export const answerEventSchema = z.object({
  type: z.literal('answer'),
  recommendations: z.array(answerRecommendationSchema),
});
export type AnswerEvent = z.infer<typeof answerEventSchema>;

/** Coverage/confidence disclosure (§5.4 rule 2, §8.6): "None of these five
 *  is tagged chosen-one. Two haven't been trope-audited yet." */
export const auditEventSchema = z.object({
  type: z.literal('audit'),
  note: z.string(),
  /** Books the disclosure is about (e.g. unaudited for the relevant tag),
   *  when it names specific books rather than the whole answer set. */
  flaggedBookIds: z.array(z.string()).optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Streamed prose for the librarian's chat bubble. */
export const tokenEventSchema = z.object({
  type: z.literal('token'),
  text: z.string(),
});
export type TokenEvent = z.infer<typeof tokenEventSchema>;

// ── new: error + done (readiness item E) ────────────────────────────────────

/**
 * `stage: 'tool'` — a single tool call threw; recoverable, the loop
 * continues (another tool call or round can still succeed).
 * `stage: 'driver'` — the `TurnDriver` itself threw, on either a normal or
 * the final forced round; never recoverable, the conversation ends.
 */
export const librarianErrorStageSchema = z.enum(['tool', 'driver']);
export type LibrarianErrorStage = z.infer<typeof librarianErrorStageSchema>;

export const errorEventSchema = z.object({
  type: z.literal('error'),
  stage: librarianErrorStageSchema,
  message: z.string(),
  recoverable: z.boolean(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

/**
 * `'exhausted'` means an answer is attached but was produced by the final
 * forced round after the normal round budget ran out — see conversation.ts's
 * invariant-5 comment at the branch that sets this. It is never reported as
 * `'answered'`.
 */
export const conversationStatusSchema = z.enum(['answered', 'exhausted', 'failed']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

/**
 * Terminal event. Exactly one is emitted per conversation, and it is always
 * the last event on the stream — see conversation.ts's `try`/`finally`. A
 * feed that stops without one is indistinguishable from "still thinking",
 * which is the bug this readiness item exists to fix.
 */
export const doneEventSchema = z.object({
  type: z.literal('done'),
  status: conversationStatusSchema,
  rounds: z.number(),
  tokensUsed: tokenUsageSchema,
});
export type DoneEvent = z.infer<typeof doneEventSchema>;

// ── union ────────────────────────────────────────────────────────────────────

export const librarianEventSchema = z.discriminatedUnion('type', [
  interpretationEventSchema,
  actionEventSchema,
  pileEventSchema,
  answerEventSchema,
  auditEventSchema,
  tokenEventSchema,
  errorEventSchema,
  doneEventSchema,
]);

export type LibrarianEvent = z.infer<typeof librarianEventSchema>;
export type LibrarianEventType = LibrarianEvent['type'];

// ── sink ─────────────────────────────────────────────────────────────────────

/**
 * The injected seam a conversation run emits through (AGENTS.md
 * dependency-injection discipline, same idiom as `llmClient.ts`'s
 * `MessageCreator`). Production wires this to `createSseEventSink` (api/);
 * tests wire it to `RecordingLibrarianEventSink` below.
 */
export interface LibrarianEventSink {
  emit(event: LibrarianEvent): void;
}

/** Test double: records every emitted event, in order, for assertion. */
export class RecordingLibrarianEventSink implements LibrarianEventSink {
  readonly events: LibrarianEvent[] = [];

  emit(event: LibrarianEvent): void {
    this.events.push(event);
  }
}
