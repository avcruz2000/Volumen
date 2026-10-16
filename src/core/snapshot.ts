import { blendTradingView, change, changePct, computeFlow, type FlowMetrics } from "./analytics.js";
import { cached, mapLimit } from "./http.js";
import { cryptoGlobal, fearGreed, fredSeries, stablecoinSupply, yahooSeries, type CryptoGlobal, type Point } from "./sources.js";
import { tvQuotes, tvSectorBreadth, tvUnusualVolume, type SectorBreadth, type UnusualVolume } from "./tradingview.js";
import { GROUP_LABELS, UNIVERSE, uniqueSymbols, type Group, type Instrument } from "./universe.js";

export type InstrumentFlow = FlowMetrics & Pick<Instrument, "name" | "group" | "risk" | "country">;

export interface Regime {
  score: number; // -100 risk-off … +100 risk-on
  label: string;
  components: {
    riskOnFlow: number;
    riskOffFlow: number;
    vix?: number;
    creditSpread1m?: number; // HYG vs IEF, puntos %
    copperGold1m?: number; // cobre vs oro, puntos %
    dollar1m?: number;
  };
}

export interface FedLiquidity {
  /** Liquidez neta = Balance Fed (WALCL) − Cuenta del Tesoro (TGA) − Repos inversos (RRP), miles de millones USD */
  latest: number;
  date: string;
  chg4w?: number;
  chg13w?: number;
  chg52w?: number;
  components: { balanceSheet: number; tga: number; rrp: number };
  series: Point[];
}

export interface Liquidity {
  fed?: FedLiquidity;
  m2?: { latest: number; date: string; yoyPct?: number };
  stablecoins?: { latest: number; date: string; chg7d?: number; chg30d?: number; chg30dPct?: number; series: Point[] };
  crypto?: CryptoGlobal;
  fearGreed?: { value: number; label: string; series: { date: string; value: number }[] };
}

export interface Snapshot {
  name: "Volumen";
  generatedAt: string;
  regime: Regime;
  liquidity: Liquidity;
  groups: Record<Group, InstrumentFlow[]>;
  groupLabels: Record<Group, string>;
  topInflows: InstrumentFlow[];
  topOutflows: InstrumentFlow[];
  tradingview?: { unusualVolume: UnusualVolume[]; cryptoUnusual: UnusualVolume[]; sectorBreadth: SectorBreadth[] };
  narrative: string[];
  errors: string[];
}

const clamp = (x: number, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, x));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function fetchFlows(symbols: string[], errors: string[] = []): Promise<Map<string, FlowMetrics>> {
  const out = new Map<string, FlowMetrics>();
  await mapLimit(symbols, 6, async (sym) => {
    try {
      const s = await yahooSeries(sym);
      if (s.bars.length < 2) throw new Error("historial insuficiente");
      out.set(sym, computeFlow(s));
    } catch (e) {
      errors.push(`${sym}: ${(e as Error).message}`);
    }
  });
  // TradingView como segunda fuente: calificación técnica + volumen intradía.
  try {
    const tv = await tvQuotes(symbols);
    for (const [sym, f] of out) out.set(sym, blendTradingView(f, tv.get(sym)));
    const missing = symbols.filter((s) => out.has(s) && !tv.has(s));
    if (missing.length) errors.push(`TradingView sin datos para: ${missing.join(", ")}`);
  } catch (e) {
    errors.push(`TradingView: ${(e as Error).message}`);
  }
  return out;
}

export function buildGroups(flows: Map<string, FlowMetrics>): Record<Group, InstrumentFlow[]> {
  const groups = { asset: [], region: [], sector: [], crypto: [], macro: [] } as Record<Group, InstrumentFlow[]>;
  for (const inst of UNIVERSE) {
    const f = flows.get(inst.symbol);
    if (!f) continue;
    groups[inst.group].push({ ...f, name: inst.name, group: inst.group, risk: inst.risk, country: inst.country });
  }
  for (const g of Object.keys(groups) as Group[]) {
    if (g !== "macro") groups[g].sort((a, b) => b.flowScore - a.flowScore);
  }
  return groups;
}

export function computeRegime(groups: Record<Group, InstrumentFlow[]>): Regime {
  const pool = [...groups.asset, ...groups.sector];
  const riskOnFlow = avg(pool.filter((i) => i.risk === "on").map((i) => i.flowScore));
  const riskOffFlow = avg(pool.filter((i) => i.risk === "off").map((i) => i.flowScore));
  const find = (sym: string) => [...groups.asset, ...groups.macro].find((i) => i.symbol === sym);
  const vix = find("^VIX")?.price;
  const hyg = find("HYG"), ief = find("IEF"), cu = find("HG=F"), au = find("GC=F"), dxy = find("DX-Y.NYB");
  const creditSpread1m = hyg && ief ? hyg.chg1m - ief.chg1m : undefined;
  const copperGold1m = cu && au ? cu.chg1m - au.chg1m : undefined;

  const score = clamp(
    0.55 * ((riskOnFlow - riskOffFlow) / 2) +
      0.15 * (vix != null ? clamp((20 - vix) * 4) : 0) +
      0.15 * (creditSpread1m != null ? clamp(creditSpread1m * 25) : 0) +
      0.15 * (copperGold1m != null ? clamp(copperGold1m * 8) : 0),
  );
  const label =
    score > 25 ? "Risk-on" : score > 8 ? "Sesgo risk-on" : score < -25 ? "Risk-off" : score < -8 ? "Sesgo risk-off" : "Neutral / rotación";
  return {
    score: Math.round(score * 10) / 10,
    label,
    components: { riskOnFlow, riskOffFlow, vix, creditSpread1m, copperGold1m, dollar1m: dxy?.chg1m },
  };
}

/** Liquidez neta de la Fed: WALCL − TGA − RRP (en miles de millones USD). */
export async function fedLiquidity(): Promise<FedLiquidity> {
  return cached("fed:netliq", 3_600_000, async () => {
    const start = "2021-01-01";
    const [walcl, tga, rrp] = await Promise.all([fredSeries("WALCL", start), fredSeries("WTREGEN", start), fredSeries("RRPONTSYD", start)]);
    const asOf = (s: Point[], date: string) => {
      let v: number | undefined;
      for (const p of s) {
        if (p.date <= date) v = p.value;
        else break;
      }
      return v;
    };
    const series: Point[] = [];
    let comp = { balanceSheet: 0, tga: 0, rrp: 0 };
    for (const p of walcl) {
      const t = asOf(tga, p.date);
      const r = asOf(rrp, p.date);
      if (t == null || r == null) continue;
      comp = { balanceSheet: p.value / 1000, tga: t / 1000, rrp: r };
      series.push({ date: p.date, value: Math.round((comp.balanceSheet - comp.tga - comp.rrp) * 10) / 10 });
    }
    const last = series.at(-1)!;
    return {
      latest: last.value,
      date: last.date,
      chg4w: change(series, 28),
      chg13w: change(series, 91),
      chg52w: change(series, 364),
      components: comp,
      series,
    };
  });
}

export async function buildLiquidity(errors: string[] = []): Promise<Liquidity> {
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const [fed, m2s, stables, crypto, fng] = await Promise.all([
    safe("FRED liquidez neta", fedLiquidity),
    safe("FRED M2", () => fredSeries("M2SL", "2020-01-01")),
    safe("DefiLlama stablecoins", stablecoinSupply),
    safe("CoinGecko global", cryptoGlobal),
    safe("Fear & Greed", () => fearGreed(90)),
  ]);
  const liq: Liquidity = { fed, crypto };
  if (m2s?.length) {
    const last = m2s.at(-1)!;
    liq.m2 = { latest: last.value, date: last.date, yoyPct: changePct(m2s, 365) };
  }
  if (stables?.length) {
    const last = stables.at(-1)!;
    liq.stablecoins = {
      latest: last.value,
      date: last.date,
      chg7d: change(stables, 7),
      chg30d: change(stables, 30),
      chg30dPct: changePct(stables, 30),
      series: stables.slice(-365),
    };
  }
  if (fng?.length) {
    liq.fearGreed = { value: fng[0].value, label: fng[0].label, series: [...fng].reverse().map(({ date, value }) => ({ date, value })) };
  }
  return liq;
}

const usd = (x: number) => {
  const a = Math.abs(x);
  const s = a >= 1e12 ? `${(a / 1e12).toFixed(2)} billones` : a >= 1e9 ? `${(a / 1e9).toFixed(1)} mil M` : `${(a / 1e6).toFixed(0)} M`;
  return `${x < 0 ? "-" : ""}$${s}`;
};

export function buildNarrative(s: Omit<Snapshot, "narrative">): string[] {
  const out: string[] = [];
  const r = s.regime;
  out.push(
    `Régimen de mercado: ${r.label} (puntuación ${Math.round(r.score)}). Flujo medio en activos de riesgo ${r.components.riskOnFlow.toFixed(0)} vs refugio ${r.components.riskOffFlow.toFixed(0)}.`,
  );
  const names = (xs: InstrumentFlow[]) => xs.map((x) => `${x.name} (${x.flowScore > 0 ? "+" : ""}${x.flowScore.toFixed(0)})`).join(", ");
  if (s.topInflows.length) out.push(`La liquidez se dirige hacia: ${names(s.topInflows.slice(0, 5))}.`);
  if (s.topOutflows.length) out.push(`La liquidez sale de: ${names(s.topOutflows.slice(0, 5))}.`);
  const reg = s.groups.region;
  if (reg.length >= 4) out.push(`Geografía — mayor atracción: ${names(reg.slice(0, 3))}; mayor salida: ${names(reg.slice(-3).reverse())}.`);
  const sec = s.groups.sector;
  if (sec.length >= 4) out.push(`Rotación sectorial EE.UU. — liderando: ${names(sec.slice(0, 3))}; rezagados: ${names(sec.slice(-3).reverse())}.`);
  const f = s.liquidity.fed;
  if (f) {
    const dir = (f.chg4w ?? 0) > 0 ? "expandiéndose" : "contrayéndose";
    out.push(
      `Liquidez neta de la Fed: $${(f.latest / 1000).toFixed(2)} billones (${f.date}), ${dir} ${f.chg4w != null ? `${f.chg4w > 0 ? "+" : ""}${f.chg4w.toFixed(0)} mil M en 4 semanas` : ""}.`,
    );
  }
  const st = s.liquidity.stablecoins;
  if (st?.chg30d != null) {
    out.push(`Stablecoins: ${usd(st.latest)} en circulación, ${st.chg30d >= 0 ? "+" : ""}${usd(st.chg30d)} en 30 días (${st.chg30d >= 0 ? "entra" : "sale"} liquidez al ecosistema cripto).`);
  }
  const c = s.liquidity.crypto;
  if (c) out.push(`Cripto: capitalización ${usd(c.totalMarketCapUsd)} (${c.marketCapChange24hPct >= 0 ? "+" : ""}${c.marketCapChange24hPct.toFixed(2)}% 24h), dominancia BTC ${c.btcDominance.toFixed(1)}%.`);
  const tv = s.tradingview;
  if (tv?.sectorBreadth.length) {
    const b = tv.sectorBreadth;
    const fmt = (x: SectorBreadth) => `${x.sector} (${x.advancingPct.toFixed(0)}% al alza)`;
    out.push(`TradingView, amplitud intradía de grandes empresas EE.UU. — dinero entrando en: ${b.slice(0, 3).map(fmt).join(", ")}; saliendo de: ${b.slice(-3).reverse().map(fmt).join(", ")}.`);
  }
  if (tv?.unusualVolume.length) {
    out.push(`Volumen inusual ahora (TradingView): ${tv.unusualVolume.slice(0, 5).map((u) => `${u.name} ${u.relVolume10d?.toFixed(1)}× (${(u.change ?? 0) >= 0 ? "+" : ""}${(u.change ?? 0).toFixed(1)}%)`).join(", ")}.`);
  }
  if (r.components.vix != null) out.push(`VIX en ${r.components.vix.toFixed(1)}${r.components.vix > 25 ? " — estrés elevado" : r.components.vix < 15 ? " — complacencia" : ""}.`);
  return out;
}

export async function buildSnapshot(): Promise<Snapshot> {
  return cached("snapshot", 60_000, async () => {
    const errors: string[] = [];
    const safe = <T>(label: string, p: Promise<T>) =>
      p.catch((e) => {
        errors.push(`${label}: ${(e as Error).message}`);
        return [] as unknown as T;
      });
    const [flows, liquidity, unusualVolume, cryptoUnusual, sectorBreadth] = await Promise.all([
      fetchFlows(uniqueSymbols(), errors),
      buildLiquidity(errors),
      safe("TradingView volumen inusual", tvUnusualVolume("america", 15)),
      safe("TradingView cripto", tvUnusualVolume("crypto", 10)),
      safe("TradingView amplitud sectorial", tvSectorBreadth()),
    ]);
    const groups = buildGroups(flows);
    const regime = computeRegime(groups);
    const seen = new Set<string>();
    const pool = [...groups.asset, ...groups.region, ...groups.sector].filter((i) => {
      if (seen.has(i.symbol)) return false;
      seen.add(i.symbol);
      return true;
    });
    const sorted = [...pool].sort((a, b) => b.flowScore - a.flowScore);
    const base = {
      name: "Volumen" as const,
      generatedAt: new Date().toISOString(),
      regime,
      liquidity,
      groups,
      groupLabels: GROUP_LABELS,
      topInflows: sorted.filter((i) => i.flowScore > 0).slice(0, 10),
      topOutflows: sorted.filter((i) => i.flowScore < 0).reverse().slice(0, 10),
      tradingview: { unusualVolume, cryptoUnusual, sectorBreadth },
      errors,
    };
    return { ...base, narrative: buildNarrative(base) };
  });
}
