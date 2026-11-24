// Token Radar model (radar-2): everything is fitted from the snapshot at runtime.
//
// The starter priced every protocol at a flat 0.25 x TVL. That is replaced here by a
// log-log comparables regression fitted on the snapshot's own token-bearing protocols:
//
//   log(mcap) ~ a + b*log(TVL) + c*growth + d*log(age) + category effects
//
// fitted by ridge least squares on the protocols whose market cap is a positive number
// (128 of the 758 here; one records mcap -1 and 16 record 0, both unusable as a log).
// No protocol name is ever special-cased and no coefficient is hardcoded: the fit runs
// again on every run, so a different snapshot gives different coefficients.
//
// The same file also carries the validation the dashboard shows (leave-one-out,
// walk-forward by listing date, leave-one-category-out, a placebo permutation test and
// a 200-resample bootstrap), the launch-odds model (Kaplan-Meier survival over the
// snapshot's own token-bearing vs pre-token protocols, by age bucket, with a TVL-tercile
// factor), and the farm plan (verdict, cost, time, $/hour, break-even deposit).
// The dashboard's app.js re-implements only the two pure functions it needs
// (feature vector + dot product) from the fitted coefficients this file writes into
// data.js, so a reader can recompute any row from the same numbers.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;
export const BOOTSTRAP_RESAMPLES = 200;
export const RIDGE_LAMBDA = 2;
export const MIN_CATEGORY_FIT = 5;

export interface FarmStep { text: string; cost: string; time: string; }

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  value_lo_usd: number;
  value_hi_usd: number;
  verdict: string;
  farm_capital_usd: number;
  farm_gas_usd: number;
  farm_hours: number;
  farm_payoff_usd: number;
  farm_per_hour_usd: number;
  breakeven_deposit_usd: number;
  min_capital_usd: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

export interface FittedModel {
  coef: number[];
  cats: string[];
  r2: number;
  sigma: number;
  smear: number;
  n_fit: number;
  intercept: number;
  b_tvl: number;
  b_growth: number;
  b_age: number;
}

export interface Validation {
  loo_med_multiple: number;
  loo_mean_multiple: number;
  loo_r2: number;
  wf_med_multiple: number;
  wf_n_test: number;
  loco_worst_med_multiple: number;
  loco_worst_cat: string;
  loco_med_multiple: number;
  placebo_r2: number;
  placebo_med_multiple: number;
  boot_slope_p10: number;
  boot_slope_p90: number;
  boot_intercept_p10: number;
  boot_intercept_p90: number;
}

export interface KmInfo {
  buckets: { lo: number; hi: number; at_risk: number; events: number; hazard_day: number }[];
  survival_1y: number;
  odds_median: number;
  tvl_factor_lo: number;
  tvl_factor_mid: number;
  tvl_factor_hi: number;
}

export interface Integrity {
  total: number;
  watchlist: number;
  board: number;
  early: number;
  live_token: number;
  pre_token: number;
  pre_token_below_floor: number;
  pre_token_above_floor_off_watchlist: number;
  pre_token_below_floor_excluded: number;
  excluded_versioned_or_cex: number;
  fit_n: number;
  fit_mcap_zero_or_neg: number;
  age_unknown: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: FittedModel;
  validation: Validation;
  km: KmInfo;
  integrity: Integrity;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  gas: { cheap_tx_usd: number; main_tx_usd: number; tx_count: number; weeks: number };
  rows: CompactRow[];
  live: LiveRow[];
}

// Compact row for data.js: [rank, slug, name, category, chains, tvl, change7d, age,
// implied, odds, expected, lo, hi, verdict, capital, gas, hours, payoff, perHour,
// breakeven, minCapital, farmSteps[]]
export type CompactRow = [number, string, string, string | null, string[], number, number | null, number | null, number, number, number, number, number, string, number, number, number, number, number, number, number, string[]];

export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Growth in fractions, winsorised so one 7-day spike cannot dominate the fit. */
export function growthFrac(p: SnapshotProtocol): number {
  return clamp(finite(p.change_7d, 0), -60, 120) / 100;
}

export function logAge(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at);
  return Math.log(Math.max(age ?? 365, 1));
}

// ------------------------------------------------------------------ linear algebra

/** Solve (X'X + lambda*I) b = X'y by Gauss-Jordan with partial pivoting. Deterministic. */
export function ridgeFit(xs: number[][], ys: number[], lambda: number): number[] {
  const k = xs[0]!.length;
  const a: number[][] = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (const x of xs) s += x[i]! * x[j]!;
      row.push(s + (i === j && i > 0 ? lambda : 0));
    }
    let b = 0;
    for (let t = 0; t < xs.length; t++) b += xs[t]![i]! * ys[t]!;
    row.push(b);
    a.push(row);
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    const tmp = a[c]!; a[c] = a[piv]!; a[piv] = tmp;
    const pv = a[c]![c]!;
    if (Math.abs(pv) < 1e-12) continue;
    for (let j = c; j <= k; j++) a[c]![j]! /= pv;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f === 0) continue;
      for (let j = c; j <= k; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((row) => row[k]!);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(ns: number[], q: number): number {
  const s = [...ns].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Seeded PRNG (mulberry32) so bootstrap and placebo are byte-identical across runs. */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the fit

/** Categories with enough fitted protocols to earn their own effect, by count then name. */
export function fitCategories(fit: SnapshotProtocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of fit) if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_CATEGORY_FIT)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([c]) => c);
}

export function features(p: SnapshotProtocol, asOf: string, cats: string[]): number[] {
  const x: number[] = [1, Math.log(Math.max(p.tvl_usd, 1)), growthFrac(p), logAge(p, asOf)];
  for (const c of cats) x.push(p.category === c ? 1 : 0);
  return x;
}

function fitStats(xs: number[][], ys: number[], coef: number[]): { r2: number; sigma: number; smear: number; resid: number[] } {
  const resid = ys.map((y, i) => y - dot(xs[i]!, coef));
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ssRes = resid.reduce((a, r) => a + r * r, 0);
  const ssTot = ys.reduce((a, y) => a + (y - mean) * (y - mean), 0);
  const sigma = Math.sqrt(ssRes / Math.max(1, ys.length - coef.length));
  const smear = resid.reduce((a, r) => a + Math.exp(r), 0) / resid.length;
  return { r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, sigma, smear, resid };
}

export function fitModel(fit: SnapshotProtocol[], asOf: string): FittedModel {
  const cats = fitCategories(fit);
  const xs = fit.map((p) => features(p, asOf, cats));
  const ys = fit.map((p) => Math.log(p.mcap_usd!));
  const coef = ridgeFit(xs, ys, RIDGE_LAMBDA);
  const st = fitStats(xs, ys, coef);
  return {
    coef: coef.map(round4), cats, r2: round4(st.r2), sigma: round4(st.sigma),
    smear: round4(st.smear), n_fit: fit.length, intercept: round4(coef[0]!),
    b_tvl: round4(coef[1]!), b_growth: round4(coef[2]!), b_age: round4(coef[3]!),
  };
}

/** Implied value from a fitted model: exp(prediction) x smearing correction, whole dollars. */
export function impliedFromModel(p: SnapshotProtocol, asOf: string, model: FittedModel): number {
  const pred = dot(features(p, asOf, model.cats), model.coef);
  const v = Math.exp(pred) * model.smear;
  if (!Number.isFinite(v)) return 1;
  return clamp(Math.round(v), 1, 1e14);
}

// ------------------------------------------------------------------ validation

function errMultiples(xs: number[][], ys: number[], coef: number[]): number[] {
  return ys.map((y, i) => Math.abs(y - dot(xs[i]!, coef)));
}

function medMultiple(errs: number[]): number {
  return Math.exp(median(errs));
}

export function validateModel(fit: SnapshotProtocol[], asOf: string, model: FittedModel): Validation {
  const cats = model.cats;
  const xs = fit.map((p) => features(p, asOf, cats));
  const ys = fit.map((p) => Math.log(p.mcap_usd!));
  // Leave-one-out: refit 128 times, predict the held-out protocol.
  const looErrs: number[] = [];
  for (let i = 0; i < fit.length; i++) {
    const c = ridgeFit(xs.filter((_, j) => j !== i), ys.filter((_, j) => j !== i), RIDGE_LAMBDA);
    looErrs.push(Math.abs(ys[i]! - dot(xs[i]!, c)));
  }
  const looMed = medMultiple(looErrs);
  const looMean = Math.exp(looErrs.reduce((a, b) => a + b, 0) / looErrs.length);
  const looMeanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const looR2 = 1 - looErrs.reduce((a, e) => a + e * e, 0) / ys.reduce((a, y) => a + (y - looMeanY) * (y - looMeanY), 0);
  // Walk-forward: train on the oldest 70% by listed_at, test the newest 30%.
  const order = fit.map((p, i) => i).sort((a, b) => {
    const da = fit[a]!.listed_at ?? '9999-12-31';
    const db = fit[b]!.listed_at ?? '9999-12-31';
    return da < db ? -1 : da > db ? 1 : a - b;
  });
  const cut = Math.floor(fit.length * 0.7);
  const trainIdx = order.slice(0, cut);
  const testIdx = order.slice(cut);
  const wfCoef = ridgeFit(trainIdx.map((i) => xs[i]!), trainIdx.map((i) => ys[i]!), RIDGE_LAMBDA);
  const wfMed = medMultiple(testIdx.map((i) => Math.abs(ys[i]! - dot(xs[i]!, wfCoef))));
  // Leave-one-category-out, for every fitted category.
  const loco: { cat: string; med: number }[] = [];
  for (const cat of cats) {
    const test = fit.map((p, i) => i).filter((i) => fit[i]!.category === cat);
    const train = fit.map((p, i) => i).filter((i) => fit[i]!.category !== cat);
    if (test.length === 0 || train.length < 20) continue;
    const c = ridgeFit(train.map((i) => xs[i]!), train.map((i) => ys[i]!), RIDGE_LAMBDA);
    loco.push({ cat, med: medMultiple(test.map((i) => Math.abs(ys[i]! - dot(xs[i]!, c)))) });
  }
  loco.sort((a, b) => b.med - a.med);
  // Placebo: shuffle the outcomes (log market cap) across the fit set with a seeded
  // RNG, then score it the same out-of-sample way as leave-one-out (refit 128 times,
  // predict the held-out protocol). A real signal must vanish: the placebo's
  // out-of-sample R2 sits near zero while the real LOO R2 stays positive. An
  // in-sample placebo R2 would not test this — 14 fitted parameters can memorise
  // about a tenth of shuffled outcomes — so the placebo is scored out of sample.
  const rng = seededRng(20261114);
  const permY = [...ys];
  for (let i = permY.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = permY[i]!; permY[i] = permY[j]!; permY[j] = t;
  }
  const pLooErrs: number[] = [];
  const pLooPred: number[] = [];
  for (let i = 0; i < fit.length; i++) {
    const c = ridgeFit(xs.filter((_, j) => j !== i), permY.filter((_, j) => j !== i), RIDGE_LAMBDA);
    const pred = dot(xs[i]!, c);
    pLooErrs.push(Math.abs(permY[i]! - pred));
    pLooPred.push(pred);
  }
  const pMeanY = permY.reduce((a, b) => a + b, 0) / permY.length;
  const pSsRes = permY.reduce((a, y, i) => a + (y - pLooPred[i]!) * (y - pLooPred[i]!), 0);
  const pSsTot = permY.reduce((a, y) => a + (y - pMeanY) * (y - pMeanY), 0);
  const placeboMed = medMultiple(pLooErrs);
  const placeboR2 = pSsTot > 0 ? 1 - pSsRes / pSsTot : 0;
  // Bootstrap: 200 resamples, slope and intercept bands.
  const bootSlopes: number[] = [];
  const bootIntercepts: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    const idx: number[] = [];
    for (let i = 0; i < fit.length; i++) idx.push(Math.floor(rng() * fit.length));
    const c = ridgeFit(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!), RIDGE_LAMBDA);
    bootSlopes.push(c[1]!);
    bootIntercepts.push(c[0]!);
  }
  return {
    loo_med_multiple: round4(looMed),
    loo_mean_multiple: round4(looMean),
    loo_r2: round4(looR2),
    wf_med_multiple: round4(wfMed),
    wf_n_test: testIdx.length,
    loco_worst_med_multiple: loco.length > 0 ? round4(loco[0]!.med) : 0,
    loco_worst_cat: loco.length > 0 ? loco[0]!.cat : '',
    loco_med_multiple: loco.length > 0 ? round4(median(loco.map((l) => l.med))) : 0,
    placebo_r2: round4(placeboR2),
    placebo_med_multiple: round4(placeboMed),
    boot_slope_p10: round4(quantile(bootSlopes, 0.1)),
    boot_slope_p90: round4(quantile(bootSlopes, 0.9)),
    boot_intercept_p10: round4(quantile(bootIntercepts, 0.1)),
    boot_intercept_p90: round4(quantile(bootIntercepts, 0.9)),
  };
}

/** Bootstrap implied-value bands (P10-P90) for each board protocol, from refitted models. */
export function bootstrapBands(
  fit: SnapshotProtocol[], asOf: string, model: FittedModel, targets: SnapshotProtocol[],
): Map<string, { lo: number; hi: number }> {
  const cats = model.cats;
  const xs = fit.map((p) => features(p, asOf, cats));
  const ys = fit.map((p) => Math.log(p.mcap_usd!));
  const rng = seededRng(20261114 + 7);
  const acc = new Map<string, number[]>();
  for (const t of targets) acc.set(t.slug, []);
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    const idx: number[] = [];
    for (let i = 0; i < fit.length; i++) idx.push(Math.floor(rng() * fit.length));
    const c = ridgeFit(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!), RIDGE_LAMBDA);
    const st = fitStats(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!), c);
    for (const t of targets) {
      const v = Math.exp(dot(features(t, asOf, cats), c)) * st.smear;
      acc.get(t.slug)!.push(clamp(Math.round(v), 1, 1e14));
    }
  }
  const out = new Map<string, { lo: number; hi: number }>();
  for (const [slug, vs] of acc) out.set(slug, { lo: Math.round(quantile(vs, 0.1)), hi: Math.round(quantile(vs, 0.9)) });
  return out;
}

// ------------------------------------------------------------------ launch odds (survival)

const KM_EDGES = [0, 180, 365, 730, 1460, 2920, 100000];

export function survivalModel(snapshot: Snapshot): { odds: (p: SnapshotProtocol) => number; km: KmInfo } {
  const asOf = snapshot.as_of;
  const aged = snapshot.protocols
    .map((p) => ({ p, age: ageDays(asOf, p.listed_at) }))
    .filter((e) => e.age !== null) as { p: SnapshotProtocol; age: number }[];
  const buckets: KmInfo['buckets'] = [];
  let surv = 1;
  let surv1y = 1;
  for (let b = 0; b < KM_EDGES.length - 1; b++) {
    const lo = KM_EDGES[b]!;
    const hi = KM_EDGES[b + 1]!;
    const atRisk = aged.filter((e) => e.age > lo).length;
    const events = aged.filter((e) => e.age > lo && e.age <= hi && !isPreToken(e.p)).length;
    const hazard = atRisk > 0 ? events / atRisk / Math.max(1, hi - lo) : 0;
    buckets.push({ lo, hi, at_risk: atRisk, events, hazard_day: round4(hazard) });
    const keep = Math.max(0, 1 - (atRisk > 0 ? events / atRisk : 0));
    surv *= keep;
    if (hi <= 365) surv1y *= keep;
  }
  // TVL tercile factor: token rate inside the tercile over the overall token rate.
  const tvls = [...aged].map((e) => e.p.tvl_usd).sort((a, b) => a - b);
  const t1 = tvls[Math.floor(tvls.length / 3)]!;
  const t2 = tvls[Math.floor((2 * tvls.length) / 3)]!;
  const overall = aged.filter((e) => !isPreToken(e.p)).length / Math.max(1, aged.length);
  const tercileRate = (lo: number, hi: number): number => {
    const sub = aged.filter((e) => e.p.tvl_usd >= lo && e.p.tvl_usd < hi);
    if (sub.length === 0) return overall;
    return sub.filter((e) => !isPreToken(e.p)).length / sub.length;
  };
  const fLo = overall > 0 ? tercileRate(0, t1) / overall : 1;
  const fMid = overall > 0 ? tercileRate(t1, t2) / overall : 1;
  const fHi = overall > 0 ? tercileRate(t2, Infinity) / overall : 1;
  const odds = (p: SnapshotProtocol): number => {
    const age = ageDays(asOf, p.listed_at) ?? 365;
    const start = age;
    const end = age + 365;
    let logSurv = 0;
    for (const bk of buckets) {
      const overlap = Math.max(0, Math.min(end, bk.hi) - Math.max(start, bk.lo));
      if (overlap > 0) logSurv -= bk.hazard_day * overlap;
    }
    let o = 1 - Math.exp(logSurv);
    const f = p.tvl_usd < t1 ? fLo : p.tvl_usd < t2 ? fMid : fHi;
    o *= clamp(f, 0.6, 1.6);
    return round4(clamp(o, 0.005, 0.65));
  };
  const medianOdds = median(snapshot.protocols.filter(isPreToken).map((p) => odds(p)));
  return {
    odds,
    km: {
      buckets, survival_1y: round4(surv1y),
      odds_median: round4(medianOdds),
      tvl_factor_lo: round4(fLo), tvl_factor_mid: round4(fMid), tvl_factor_hi: round4(fHi),
    },
  };
}

// ------------------------------------------------------------------ farm plan

const CHEAP_CHAINS = new Set(['Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'zkSync Era', 'Linea', 'Blast', 'Scroll', 'Mode', 'Sonic', 'Berachain', 'Unichain']);
const GAS_TX_COUNT = 10;
const GAS_WEEKS = 8;

export function gasPerTx(p: SnapshotProtocol): number {
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  return CHEAP_CHAINS.has(chain) ? 1 : 5;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one small market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('farm')) return `Stake $${capital} of LP tokens in ${name}'s farm on ${chain} and harvest weekly.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(p);
  const action = actionFor(p, capital, chain);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'no capital, under $1 of gas to set up', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: `about $${gas} of gas a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/**
 * Farm economics. Assumptions, stated on the dashboard: a small farmer captures
 * 0.002% of the protocol's expected value if a token launches, capped at $800 —
 * airdrops are shared across thousands of farmers, so one small position never
 * scales linearly with a $500M valuation; gas is $1 per transaction on a cheap
 * chain and $5 elsewhere, 10 transactions over 8 weeks; time is 3.5 hours.
 * Verdict: FARM at $20+/hour, THIN at $5+/hour, else SKIP. Break-even deposit is
 * the deposit at which 8 weeks of gas is 2% of the deposit; minimum capital is
 * the deposit at which gas is 5% of it.
 */
export function farmEconomics(p: SnapshotProtocol, expectedValue: number): {
  verdict: string; capital: number; gas: number; hours: number; payoff: number;
  perHour: number; breakeven: number; minCapital: number;
} {
  const gas = gasPerTx(p) * GAS_TX_COUNT;
  const hours = 3.5;
  const payoff = Math.max(0, Math.round((Math.min(expectedValue * 0.00002, 800) - gas) * 100) / 100);
  const perHour = Math.round((payoff / hours) * 100) / 100;
  const verdict = perHour >= 20 ? 'FARM' : perHour >= 5 ? 'THIN' : 'SKIP';
  const breakeven = Math.ceil(gas / 0.02 / 10) * 10;
  const minCapital = Math.max(25, Math.ceil(gas / 0.05 / 10) * 10);
  return { verdict, capital: capitalFor(p), gas, hours, payoff, perHour, breakeven, minCapital };
}

// ------------------------------------------------------------------ board

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const model = fitModel(fit, snapshot.as_of);
  const validation = validateModel(fit, snapshot.as_of, model);
  const surv = survivalModel(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Early radar: pre-token protocols below the floor, ranked by the fitted model's
  // implied value (not by TVL alone), capped at 160. A chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, implied: impliedFromModel(p, snapshot.as_of, model) }))
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, EARLY_ROWS)
    .map((e) => e.p);
  for (const p of early) chosen.set(p.slug, p);
  const bands = bootstrapBands(fit, snapshot.as_of, model, [...chosen.values()]);
  const scored = [...chosen.values()].map((p) => {
    const implied = impliedFromModel(p, snapshot.as_of, model);
    const odds = surv.odds(p);
    const expected = Math.max(1, Math.round(implied * odds));
    const band = bands.get(p.slug) ?? { lo: implied, hi: implied };
    const age = ageDays(snapshot.as_of, p.listed_at);
    const econ = farmEconomics(p, expected);
    return { p, implied, odds, expected, band, age, econ };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.age,
    implied_value_usd: s.implied,
    launch_odds: s.odds,
    expected_value_usd: s.expected,
    value_lo_usd: s.band.lo,
    value_hi_usd: s.band.hi,
    verdict: s.econ.verdict,
    farm_capital_usd: s.econ.capital,
    farm_gas_usd: s.econ.gas,
    farm_hours: s.econ.hours,
    farm_payoff_usd: s.econ.payoff,
    farm_per_hour_usd: s.econ.perHour,
    breakeven_deposit_usd: s.econ.breakeven,
    min_capital_usd: s.econ.minCapital,
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  const live = liveRows(snapshot);
  const preToken = snapshot.protocols.filter(isPreToken);
  const belowFloor = preToken.filter((p) => p.tvl_usd < snapshot.floor_usd && !snapshot.watchlist.includes(p.slug));
  const integrity: Integrity = {
    total: snapshot.protocols.length,
    watchlist: snapshot.watchlist.length,
    board: board.length,
    early: early.length,
    live_token: snapshot.protocols.length - preToken.length,
    pre_token: preToken.length,
    pre_token_below_floor: belowFloor.length,
    pre_token_above_floor_off_watchlist: preToken.filter((p) => p.tvl_usd >= snapshot.floor_usd && !snapshot.watchlist.includes(p.slug)).length,
    pre_token_below_floor_excluded: belowFloor.length - early.length,
    excluded_versioned_or_cex: preToken.filter((p) => !isRankable(p) && !snapshot.watchlist.includes(p.slug)).length,
    fit_n: fit.length,
    fit_mcap_zero_or_neg: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd <= 0).length,
    age_unknown: snapshot.protocols.filter((p) => p.listed_at === null).length,
  };
  const rows: CompactRow[] = board.map((r) => [
    r.rank, r.slug, r.name, r.category, r.chains, r.tvl_usd, r.change_7d, r.age_days,
    r.implied_value_usd, r.launch_odds, r.expected_value_usd, r.value_lo_usd, r.value_hi_usd,
    r.verdict, r.farm_capital_usd, r.farm_gas_usd, r.farm_hours, r.farm_payoff_usd,
    r.farm_per_hour_usd, r.breakeven_deposit_usd, r.min_capital_usd, r.farm_steps,
  ]);
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION, model, validation, km: surv.km, integrity,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: early.length, live_size: live.length,
    gas: { cheap_tx_usd: 1, main_tx_usd: 5, tx_count: GAS_TX_COUNT, weeks: GAS_WEEKS },
    rows, live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
