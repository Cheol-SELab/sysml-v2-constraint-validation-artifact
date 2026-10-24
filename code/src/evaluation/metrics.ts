/** Detection metrics against the injection oracle (section 6.4). */

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
}

export function emptyConfusion(): Confusion {
  return { tp: 0, fp: 0, fn: 0 };
}

export function addConfusion(a: Confusion, b: Confusion): Confusion {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

/** Compares the reported violation keys with the expected keys of one defect. */
export function confusionFor(expected: Set<string>, reported: Set<string>): Confusion {
  let tp = 0;
  let fn = 0;
  for (const k of expected) {
    if (reported.has(k)) tp++;
    else fn++;
  }
  let fp = 0;
  for (const k of reported) if (!expected.has(k)) fp++;
  return { tp, fp, fn };
}

export function precision(c: Confusion): number {
  return c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
}

export function recall(c: Confusion): number {
  return c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
}

export function f1(c: Confusion): number {
  const p = precision(c);
  const r = recall(c);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}
