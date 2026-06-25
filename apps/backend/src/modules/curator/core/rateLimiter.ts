/**
 * Token-bucket rate limiter for Anthropic calls.
 *
 * Enforces both a requests-per-minute (RPM) and a tokens-per-minute (TPM)
 * ceiling. `acquire(estimatedTokens)` resolves when there is capacity for one
 * request plus the estimated token cost; bursts beyond the ceiling QUEUE rather
 * than reject (adversarial: "burst beyond RPM must queue, not reject").
 *
 * Admission is serialized through a FIFO promise chain so callers are granted
 * capacity in arrival order (no starvation, D1–D3). `acquire` never rejects.
 *
 * `now` and `sleep` are injectable so the throughput behavior can be tested
 * deterministically with a virtual clock instead of real timers.
 */
import { nullLogger, type Logger } from './logger.js';

export type NowFn = () => number;
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  rpm: number;
  tpm: number;
  now?: NowFn;
  sleep?: SleepFn;
  logger?: Logger;
}

export class TokenBucketRateLimiter {
  private readonly rpm: number;
  private readonly tpm: number;
  private readonly reqPerMs: number;
  private readonly tokPerMs: number;
  private readonly now: NowFn;
  private readonly sleep: SleepFn;
  private readonly logger: Logger;

  private requestCapacity: number;
  private tokenCapacity: number;
  private lastRefill: number;
  /** FIFO admission chain — each acquire waits for the previous to be granted. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.rpm = Math.max(1, options.rpm);
    this.tpm = Math.max(1, options.tpm);
    this.reqPerMs = this.rpm / 60_000;
    this.tokPerMs = this.tpm / 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.logger = options.logger ?? nullLogger;

    // Start full so an initial burst up to the ceiling passes immediately.
    this.requestCapacity = this.rpm;
    this.tokenCapacity = this.tpm;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.requestCapacity = Math.min(this.rpm, this.requestCapacity + elapsed * this.reqPerMs);
    this.tokenCapacity = Math.min(this.tpm, this.tokenCapacity + elapsed * this.tokPerMs);
    this.lastRefill = t;
  }

  /**
   * Resolve once there is capacity for one request and `estimatedTokens` tokens.
   * A request larger than the entire TPM ceiling is clamped to the ceiling so it
   * can never deadlock the bucket.
   */
  async acquire(estimatedTokens: number): Promise<void> {
    const need = Math.min(Math.max(estimatedTokens, 0), this.tpm);

    const run = async (): Promise<void> => {
      for (;;) {
        this.refill();
        if (this.requestCapacity >= 1 && this.tokenCapacity >= need) {
          this.requestCapacity -= 1;
          this.tokenCapacity -= need;
          return;
        }
        const waitForReq =
          this.requestCapacity >= 1 ? 0 : (1 - this.requestCapacity) / this.reqPerMs;
        const waitForTok =
          this.tokenCapacity >= need ? 0 : (need - this.tokenCapacity) / this.tokPerMs;
        const waitMs = Math.max(Math.ceil(Math.max(waitForReq, waitForTok)), 1);
        this.logger.debug('Rate limit reached — queuing', { waitMs, need });
        await this.sleep(waitMs);
      }
    };

    // Serialize admission: this acquire only starts waiting after the previous
    // one has been granted, preserving FIFO order.
    const result = this.chain.then(run);
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Current capacity snapshot (for tests / observability). */
  snapshot(): { requestCapacity: number; tokenCapacity: number } {
    this.refill();
    return { requestCapacity: this.requestCapacity, tokenCapacity: this.tokenCapacity };
  }
}
