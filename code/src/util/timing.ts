/** Timing helper: one warm-up run followed by `reps` measured runs, median reported (ms). */
export function timeMedian(fn: () => void, reps = 5): number {
  fn();
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 1 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
}
