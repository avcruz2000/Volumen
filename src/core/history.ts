/**
 * Historial de flujos de liquidez: todo el historial diario disponible en Yahoo Finance
 * (SPY desde 1993, sectores desde 1998, países desde 1996…) agregado por mes y por semana.
 *
 * Por periodo y por instrumento:
 *   ret  — rendimiento del periodo (%)
 *   dv   — volumen negociado en USD (millones)
 *   nf   — flujo neto de dinero en USD (millones): Σ (posición del cierre en el rango) × precio × volumen
 *   intensidad = nf / dv × 100 (−100 … +100): comparable entre activos y a lo largo del tiempo
 */
import { cached, getJson, mapLimit } from "./http.js";
import { fearGreed, fredSeries, stablecoinSupply, type Point } from "./sources.js";
import { GROUP_LABELS, UNIVERSE, type Group } from "./universe.js";

export type Resolution = "monthly" | "weekly";

export interface DailyBar {
  t: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Todo el historial diario de un símbolo. */
export async function yahooDailyMax(symbol: string): Promise<DailyBar[]> {
  return cached(`yfmax:${symbol}`, 6 * 3_600_000, async () => {
    const now = Math.floor(Date.now() / 1000);
    let data: any;
    let lastErr: unknown;
    for (const host of ["query1", "query2"]) {
      try {
        data = await getJson(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${now}&interval=1d&includePrePost=false`,
          { retries: 2, timeoutMs: 30000 },
        );
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    const r = data?.chart?.result?.[0];
    if (!r) throw lastErr ?? new Error(`Sin historial para ${symbol}`);
    const q = r.indicators?.quote?.[0] ?? {};
    const ts: number[] = r.timestamp ?? [];
    const out: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null || !isFinite(c)) continue;
      out.push({ t: ts[i], h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? 0 });
    }
    return out;
  });
}

const monthKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);
/** Clave semanal = lunes de la semana (YYYY-MM-DD, UTC). */
function weekKey(t: number): string {
  const d = new Date(t * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export interface PeriodFlow {
  period: string;
  close: number;
  ret: number | null; // %
  dv: number; // millones USD
  nf: number; // millones USD
}

export function aggregate(bars: DailyBar[], res: Resolution): PeriodFlow[] {
  const keyOf = res === "monthly" ? monthKey : weekKey;
  const out: PeriodFlow[] = [];
  let cur: PeriodFlow | null = null;
  let prevClose: number | undefined;
  let periodStartClose: number | undefined;
  for (const b of bars) {
    const k = keyOf(b.t);
    if (!cur || cur.period !== k) {
      if (cur) out.push(cur);
      periodStartClose = out.length ? out[out.length - 1].close : undefined;
      cur = { period: k, close: b.c, ret: null, dv: 0, nf: 0 };
    }
    const range = b.h - b.l;
    const mfm = range > 0 ? (b.c - b.l - (b.h - b.c)) / range : prevClose != null ? Math.sign(b.c - prevClose) : 0;
    const dollars = (b.c * b.v) / 1e6;
    cur.dv += dollars;
    cur.nf += mfm * dollars;
    cur.close = b.c;
    cur.ret = periodStartClose ? ((b.c - periodStartClose) / periodStartClose) * 100 : null;
    prevClose = b.c;
  }
  if (cur) out.push(cur);
  return out;
}

const r1 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

export interface SeriesHistory {
  symbol: string;
  name: string;
  risk?: "on" | "off";
  country?: string;
  start: string; // primer periodo con datos
  ret: (number | null)[];
  dv: (number | null)[];
  nf: (number | null)[];
}

export interface GroupHistory {
  group: Group;
  label: string;
  resolution: Resolution;
  generatedAt: string;
  periods: string[];
  series: SeriesHistory[];
}

/** Historial alineado (mismo eje de periodos) para un conjunto de instrumentos. */
export async function buildGroupHistory(
  group: Group,
  res: Resolution,
  opts: { maxPeriods?: number; symbols?: string[]; errors?: string[] } = {},
): Promise<GroupHistory> {
  const insts = UNIVERSE.filter((i) => i.group === group && (!opts.symbols || opts.symbols.includes(i.symbol)));
  const perSymbol = new Map<string, PeriodFlow[]>();
  await mapLimit(insts, 4, async (inst) => {
    try {
      perSymbol.set(inst.symbol, aggregate(await yahooDailyMax(inst.symbol), res));
    } catch (e) {
      opts.errors?.push(`${inst.symbol}: ${(e as Error).message}`);
    }
  });
  const all = new Set<string>();
  for (const f of perSymbol.values()) for (const p of f) all.add(p.period);
  let periods = [...all].sort();
  // El último periodo es el actual (parcial).
  if (opts.maxPeriods && periods.length > opts.maxPeriods) periods = periods.slice(-opts.maxPeriods);
  const idx = new Map(periods.map((p, i) => [p, i]));

  const series: SeriesHistory[] = [];
  for (const inst of insts) {
    const f = perSymbol.get(inst.symbol);
    if (!f) continue;
    const ret = new Array(periods.length).fill(null);
    const dv = new Array(periods.length).fill(null);
    const nf = new Array(periods.length).fill(null);
    for (const p of f) {
      const i = idx.get(p.period);
      if (i == null) continue;
      ret[i] = r2(p.ret);
      dv[i] = p.dv > 0 ? r1(p.dv) : null;
      nf[i] = p.dv > 0 ? r1(p.nf) : null;
    }
    const first = f.find((p) => p.dv > 0)?.period ?? f[0]?.period;
    series.push({ symbol: inst.symbol, name: inst.name, risk: inst.risk, country: inst.country, start: first, ret, dv, nf });
  }
  return { group, label: GROUP_LABELS[group], resolution: res, generatedAt: new Date().toISOString(), periods, series };
}

export const intensity = (nf: number | null, dv: number | null) => (nf == null || !dv ? null : (nf / dv) * 100);

/**
 * Régimen histórico: intensidad media de flujo en activos de riesgo menos la de refugio, por periodo.
 */
export function regimeHistory(...groups: GroupHistory[]): { periods: string[]; values: (number | null)[] } {
  const periods = [...new Set(groups.flatMap((g) => g.periods))].sort();
  const values = periods.map((p) => {
    const on: number[] = [];
    const off: number[] = [];
    for (const g of groups) {
      const i = g.periods.indexOf(p);
      if (i < 0) continue;
      for (const s of g.series) {
        const x = intensity(s.nf[i], s.dv[i]);
        if (x == null) continue;
        if (s.risk === "on") on.push(x);
        else if (s.risk === "off") off.push(x);
      }
    }
    if (on.length < 2 || off.length < 2) return null;
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    return r1(avg(on) - avg(off));
  });
  return { periods, values };
}

export interface MacroHistory {
  generatedAt: string;
  fedNetLiquidity: Point[]; // semanal desde 2002, miles de millones USD
  fedBalanceSheet: Point[];
  m2: Point[]; // mensual desde 1959, miles de millones USD
  stablecoins: Point[]; // semanal desde 2017, miles de millones USD
  fearGreed: Point[]; // semanal desde 2018
  vix: Point[]; // mensual desde 1990
}

/** Muestra una serie diaria a frecuencia semanal (último valor de cada semana). */
function weekly(points: Point[]): Point[] {
  const out = new Map<string, Point>();
  for (const p of points) out.set(weekKey(Date.parse(p.date) / 1000), p);
  return [...out.values()];
}

export async function buildMacroHistory(errors: string[] = []): Promise<MacroHistory> {
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return fallback;
    }
  };
  const [walcl, tga, rrp, m2, stables, fng, vixBars] = await Promise.all([
    safe("WALCL", () => fredSeries("WALCL"), [] as Point[]),
    safe("WTREGEN", () => fredSeries("WTREGEN"), [] as Point[]),
    safe("RRPONTSYD", () => fredSeries("RRPONTSYD"), [] as Point[]),
    safe("M2SL", () => fredSeries("M2SL"), [] as Point[]),
    safe("Stablecoins", stablecoinSupply, [] as Point[]),
    safe("Fear & Greed", () => fearGreed(0), [] as { date: string; value: number }[]),
    safe("VIX", () => yahooDailyMax("^VIX"), [] as DailyBar[]),
  ]);
  // Liquidez neta: WALCL − TGA − RRP (RRP anterior a 2003 = 0).
  const fedNet: Point[] = [];
  const fedBs: Point[] = [];
  let ti = 0, ri = 0, tv: number | undefined, rv = 0;
  for (const p of walcl) {
    while (ti < tga.length && tga[ti].date <= p.date) tv = tga[ti++].value;
    while (ri < rrp.length && rrp[ri].date <= p.date) rv = rrp[ri++].value;
    fedBs.push({ date: p.date, value: Math.round(p.value / 100) / 10 });
    if (tv == null) continue;
    fedNet.push({ date: p.date, value: Math.round((p.value / 1000 - tv / 1000 - rv) * 10) / 10 });
  }
  const vixMonthly = aggregate(vixBars, "monthly").map((p) => ({ date: p.period, value: Math.round(p.close * 100) / 100 }));
  return {
    generatedAt: new Date().toISOString(),
    fedNetLiquidity: fedNet,
    fedBalanceSheet: fedBs,
    m2,
    stablecoins: weekly(stables).map((p) => ({ date: p.date, value: Math.round(p.value / 1e7) / 100 })),
    fearGreed: weekly([...fng].reverse().map((x) => ({ date: x.date, value: x.value }))),
    vix: vixMonthly,
  };
}
