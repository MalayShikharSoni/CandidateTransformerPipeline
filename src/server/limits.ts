import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Abuse and cost guards for the public deployment. They live in memory, which
 * is right for one server process (Render runs a single instance). If the app
 * ever runs on several instances, these need a shared store instead.
 */

export type Clock = () => number;

/** At most `limit` runs per key in any rolling `windowMs`. limit <= 0 means unlimited. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    if (this.limit <= 0) return { ok: true };
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep the map from growing without bound on a busy day.
    if (this.hits.size > 10_000) {
      for (const [k, list] of this.hits) {
        if (list.every((at) => now - at >= this.windowMs)) this.hits.delete(k);
      }
    }
    return { ok: true };
  }
}

/** A daily allowance of Claude calls, reset at UTC midnight. */
export class DailyBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly cap: number,
    private readonly now: Clock = Date.now,
  ) {}

  private roll() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  /** Reserves n calls; false (and nothing reserved) if that would pass the cap. */
  tryTake(n: number): boolean {
    this.roll();
    if (this.used + n > this.cap) return false;
    this.used += n;
    return true;
  }

  remaining(): number {
    this.roll();
    return Math.max(0, this.cap - this.used);
  }
}

/** Constant-time comparison, so response timing reveals nothing about the code. */
export function accessCodeMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The caller's IP. Behind a proxy (Render), X-Forwarded-For lists hops; the
 * entry `trustedHops` from the right was added by our proxy, so it can't be
 * spoofed by the client the way the leftmost entry can. Without a trusted
 * proxy, the socket address is used.
 */
export function clientIp(forwardedFor: string | undefined, socketIp: string | undefined, trustedHops: number): string {
  if (trustedHops > 0 && forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const ip = hops[hops.length - trustedHops] ?? hops[0];
    if (ip) return ip;
  }
  return socketIp ?? "unknown";
}

export function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "a minute" : `${minutes} min`;
}
