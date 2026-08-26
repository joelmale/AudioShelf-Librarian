/**
 * Outbound politeness controls for the enrichment providers.
 *
 * Why this is needed at all: `enricher.ts` runs a `p-limit` pool of
 * `concurrency` books in parallel, and each book calls every due provider.
 * Without a shared gate the request rate to a given third party is
 * `concurrency`-multiplied and bursty — which is how a self-hosted tool gets
 * its IP blocked from a free community API. Two of our three providers
 * (Open Library, Audnexus) are donation-funded services with no paid tier to
 * fall back on if we abuse them.
 *
 * The limiter is module-scoped per provider, NOT per lookup, so it throttles
 * across the whole concurrent pool rather than per book.
 */

/** Descriptive User-Agent. Open Library's docs explicitly ask API consumers to
 *  identify themselves and throttle generic/absent-UA traffic; the others
 *  simply behave better with one. */
export const USER_AGENT = 'AudioShelf-Librarian/1.0 (self-hosted audiobook library curator)';

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
};

/**
 * Minimum spacing between requests to a single provider, in ms.
 *
 * Open Library is the most conservative (1 req/s): it serves an expensive
 * Solr search and is the likeliest of the three to throttle a bulk consumer.
 * Audnexus is a small community service. Google Books is metered by a
 * per-DAY quota rather than a rate, so spacing there is politeness plus a
 * brake on burning the day's allowance in one burst.
 *
 * These make a full-library run slow on purpose — enrichment already runs as
 * a cancellable background operation with progress, so wall-clock is the
 * cheapest thing to spend here.
 */
export const OPEN_LIBRARY_MIN_INTERVAL_MS = 1_000;
export const AUDNEXUS_MIN_INTERVAL_MS = 500;
// Raised from 250ms after a live run: at 4 req/s Google Books returned 429
// frequently, and its 429 is usually a SHORT-WINDOW burst limit (six probes a
// few seconds later all returned 200) rather than the per-day quota. Halving
// the rate costs wall-clock on a background job and buys a much lower failure
// rate.
export const GOOGLE_BOOKS_MIN_INTERVAL_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Vitest sets `VITEST`; under it every interval collapses to 0 so the provider
 * suites don't spend real seconds sleeping. Deliberately env-sniffed rather
 * than threaded through `EnrichmentProvider.lookup`, whose signature is fixed
 * by the provider contract. Throttling behaviour itself is still tested
 * directly against `RateLimiter` with explicit intervals.
 */
function effectiveInterval(ms: number): number {
  return process.env.VITEST ? 0 : ms;
}

/**
 * Serializes acquisitions and spaces them by at least `minIntervalMs`.
 *
 * `penalize()` pushes the next allowed slot further out — used to honour a
 * `Retry-After` (or to back off after a 429) so that *every* in-flight book
 * waits, not just the one that got the error.
 */
export class RateLimiter {
  private nextAllowedAt = 0;
  /** Tail of the serialization chain. Never rejects — a failed acquire must
   *  not wedge every later caller. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * `penaltiesEnabled` is separate from `minIntervalMs` because the two are
   * silenced under different conditions: `createRateLimiter` zeroes the
   * interval under Vitest AND disables penalties, so a provider test that
   * exercises a 429 path does not actually sleep out its back-off. The
   * penalty logic itself is still covered — `throttle.test.ts` constructs
   * `RateLimiter` directly, where penalties stay on.
   */
  constructor(
    private readonly minIntervalMs: number,
    private readonly penaltiesEnabled: boolean = true
  ) {}

  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** Delay the next slot by at least `ms` from now (idempotent-safe: only ever
   *  pushes the deadline later, never pulls it in). */
  penalize(ms: number): void {
    if (!this.penaltiesEnabled) return;
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms);
  }
}

export function createRateLimiter(minIntervalMs: number): RateLimiter {
  return new RateLimiter(effectiveInterval(minIntervalMs), !process.env.VITEST);
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Returns ms, or null
 *  when absent/unparseable. Capped at 5 minutes so a hostile or mistaken
 *  header can't stall an entire run. */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 300_000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), 300_000);
}

/**
 * Marks an error as "stop asking this provider for now" — a 429/403, i.e. a
 * quota or rate condition. Providers that try several title candidates per
 * book MUST abort that loop when this is set: retrying the next candidate
 * after a rate-limit response is precisely the behaviour that escalates a
 * throttle into a ban.
 */
export const RATE_LIMITED = Symbol('rateLimited');

export function markRateLimited<T extends object>(err: T): T {
  Object.defineProperty(err, RATE_LIMITED, { value: true, enumerable: false });
  return err;
}

export function isRateLimited(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as Record<symbol, unknown>)[RATE_LIMITED]);
}
