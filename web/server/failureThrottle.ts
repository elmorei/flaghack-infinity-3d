/**
 * Sliding window of failed password attempts per key (an addressKey): `limit` failures within
 * `windowMs` block that key until the oldest of them ages out.
 */
export class FailureThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly failures = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  blocked(address: string, now: number): boolean {
    const times = this.failures.get(address);
    if (!times) return false;
    this.prune(times, now);
    return times.length >= this.limit;
  }

  fail(address: string, now: number): void {
    const times = this.failures.get(address);
    if (times) times.push(now);
    else this.failures.set(address, [now]);
  }

  /** Forget addresses whose failures have all aged out (keeps the table from growing). */
  sweep(now: number): void {
    for (const [address, times] of this.failures) {
      this.prune(times, now);
      if (times.length === 0) this.failures.delete(address);
    }
  }

  private prune(times: number[], now: number): void {
    let stale = 0;
    while (stale < times.length && now - times[stale] >= this.windowMs) stale++;
    if (stale > 0) times.splice(0, stale);
  }
}
