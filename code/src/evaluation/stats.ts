/**
 * Statistics used in the evaluation (section 6.9). Only non-parametric procedures are
 * used: percentile bootstrap for interval estimates, ordinary least squares with a
 * bootstrap interval for the complexity exponent, and the two-sample
 * Kolmogorov-Smirnov statistic for the calibration check.
 */

import { Rng } from '../util/rng';

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, r) => p - r);
  const idx = (a.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/** Percentile bootstrap interval for the median. */
export function bootstrapMedianCI(xs: number[], iterations = 2000, seed = 20260101): Interval {
  if (xs.length === 0) return { point: NaN, lo: NaN, hi: NaN };
  const rng = new Rng(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < xs.length; j++) sample.push(xs[rng.int(xs.length)]);
    stats.push(median(sample));
  }
  return { point: median(xs), lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) };
}

export interface Regression {
  slope: number;
  intercept: number;
  r2: number;
}

export function ols(xs: number[], ys: number[]): Regression {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ssTot += (ys[i] - my) * (ys[i] - my);
    ssRes += (ys[i] - pred) * (ys[i] - pred);
  }
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

/** Bootstrap interval for the OLS slope (pairs resampling). */
export function bootstrapSlopeCI(xs: number[], ys: number[], iterations = 2000, seed = 20260102): Interval {
  const rng = new Rng(seed);
  const slopes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let j = 0; j < xs.length; j++) {
      const k = rng.int(xs.length);
      bx.push(xs[k]);
      by.push(ys[k]);
    }
    const r = ols(bx, by);
    if (Number.isFinite(r.slope)) slopes.push(r.slope);
  }
  const point = ols(xs, ys).slope;
  return { point, lo: quantile(slopes, 0.025), hi: quantile(slopes, 0.975) };
}

export interface KsResult {
  d: number;
  criticalValue005: number;
  reject005: boolean;
  n1: number;
  n2: number;
}

/** Two-sample Kolmogorov-Smirnov statistic with the asymptotic 5% critical value. */
export function ksTwoSample(a: number[], b: number[]): KsResult {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  const n1 = x.length;
  const n2 = y.length;
  if (n1 === 0 || n2 === 0) return { d: NaN, criticalValue005: NaN, reject005: false, n1, n2 };
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < n1 && j < n2) {
    const v = Math.min(x[i], y[j]);
    while (i < n1 && x[i] <= v) i++;
    while (j < n2 && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / n1 - j / n2));
  }
  const critical = 1.36 * Math.sqrt((n1 + n2) / (n1 * n2));
  return { d, criticalValue005: critical, reject005: d > critical, n1, n2 };
}

export function round(x: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
