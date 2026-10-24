/** Deterministic PRNG (mulberry32). Every experiment is a pure function of its seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  range(minInclusive: number, maxInclusive: number): number {
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  pick<T>(items: T[]): T {
    return items[this.int(items.length)];
  }

  shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }
}
