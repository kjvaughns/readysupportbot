import { isMutating, type ActionType } from '../domain/actions.js';

/**
 * Per-user rate limiting.
 *
 * Token buckets held in memory. A restart resets them, which is acceptable:
 * the limits exist to stop accidental floods and to blunt an abusive burst,
 * not to enforce a billing quota. Anything that must survive a restart is
 * enforced by the approval flow instead.
 *
 * Read and write budgets are separate so that someone polling
 * `/license_usage` cannot exhaust their ability to run a real change.
 */

export interface BucketConfig {
  /** Maximum tokens held at once — the size of an allowed burst. */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
}

export const DEFAULT_READ_BUDGET: BucketConfig = { capacity: 20, refillPerMinute: 20 };
export const DEFAULT_WRITE_BUDGET: BucketConfig = { capacity: 6, refillPerMinute: 6 };
/** Natural language costs an OpenAI call, so it gets its own tighter budget. */
export const DEFAULT_NL_BUDGET: BucketConfig = { capacity: 10, refillPerMinute: 10 };

export type BudgetKind = 'read' | 'write' | 'nl';

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the next token is available. Zero when allowed. */
  retryAfterMs: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly budgets: Record<BudgetKind, BucketConfig> = {
      read: DEFAULT_READ_BUDGET,
      write: DEFAULT_WRITE_BUDGET,
      nl: DEFAULT_NL_BUDGET,
    },
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Consume a token. Returns whether the caller may proceed and, when not, how
   * long they should wait.
   */
  consume(userId: string, kind: BudgetKind): RateLimitDecision {
    const config = this.budgets[kind];
    const key = `${kind}:${userId}`;
    const now = this.clock();

    const bucket = this.buckets.get(key) ?? { tokens: config.capacity, lastRefillMs: now };

    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refilled = (elapsedMs / 60_000) * config.refillPerMinute;
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refilled);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      const msPerToken = 60_000 / config.refillPerMinute;
      const retryAfterMs = Math.ceil((1 - bucket.tokens) * msPerToken);
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
  }

  /** Which budget an action draws from. */
  static budgetFor(action: ActionType): BudgetKind {
    return isMutating(action) ? 'write' : 'read';
  }

  /** Drop buckets that have been idle long enough to be back at capacity. */
  prune(idleMs = 15 * 60_000): void {
    const cutoff = this.clock() - idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < cutoff) this.buckets.delete(key);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** Shared instance used by the Discord layer. */
export const rateLimiter = new RateLimiter();
