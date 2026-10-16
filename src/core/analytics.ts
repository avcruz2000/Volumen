import type { Bar, Point, Series } from "./sources.js";
import type { TvData } from "./tradingview.js";

export interface FlowMetrics {
  symbol: string;
  price: number;
  chg1d: number; // %
  chg5d: number;
  chg1m: number;
  chg3m: number;
  /** Volumen en USD de la sesión actual, proyectado a sesión completa si el mercado está abierto */
  dollarVolume: number;
  avgDollarVolume20: number;
  /** Volumen relativo: sesión actual / media 20 sesiones */
  relVolume: number;
  /** Chaikin Money Flow 20 sesiones (-1..1): presión compradora/vendedora ponderada por volumen */
  cmf20: number;
  /** Flujo neto de dinero estimado últimas 5 sesiones en USD (money-flow volume) */
  netFlow5d: number;
  /** Igual que netFlow5d pero de 20 sesiones */
  netFlow20d: number;
  /** Puntuación compuesta de flujo de liquidez (-100 salida fuerte … +100 entrada fuerte) */
  flowScore: number;
  signal: "Entrada fuerte" | "Entrada" | "Neutral" | "Salida" | "Salida fuerte";
  asOf: string;
  /** Puntuación solo con el modelo de volumen (antes de mezclar TradingView) */
  volumeScore?: number;
  /** Datos de TradingView: calificación técnica, RSI, volumen relativo intradía… */
  tv?: TvData;
  /** ¿TradingView confirma la dirección del flujo? */
  tvConfirms?: boolean;
}

/** Peso de la calificación técnica de TradingView en la puntuación final. */
export const TV_WEIGHT = 0.15;

/** Mezcla la calificación técnica de TradingView (−1…+1) en la puntuación de flujo. */
export function blendTradingView(f: FlowMetrics, tv: TvData | undefined): FlowMetrics {
  if (!tv) return f;
  const out: FlowMetrics = { ...f, tv, volumeScore: f.flowScore };
  if (tv.rating != null) {
    const score = Math.max(-100, Math.min(100, (1 - TV_WEIGHT) * f.flowScore + TV_WEIGHT * tv.rating * 100));
    out.flowScore = Math.round(score * 10) / 10;
    out.signal = signalOf(score);
    out.tvConfirms = Math.abs(f.flowScore) < 15 || Math.abs(tv.rating) < 0.1 ? undefined : Math.sign(f.flowScore) === Math.sign(tv.rating);
  }
  return out;
}

const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Multiplicador de money flow de una vela: +1 cierre en máximo, -1 cierre en mínimo. */
function mfm(b: Bar, prevClose?: number): number {
  const range = b.h - b.l;
  if (range > 0) return (b.c - b.l - (b.h - b.c)) / range;
  if (prevClose != null) return Math.sign(b.c - prevClose);
  return 0;
}

export function computeFlow(s: Series): FlowMetrics {
  const bars = s.bars;
  const n = bars.length;
  const last = bars[n - 1];
  const closeAgo = (k: number) => bars[Math.max(0, n - 1 - k)]?.c ?? last.c;

  const dv = bars.map((b) => b.c * b.v);
  const hist = dv.slice(Math.max(0, n - 21), n - 1);
  const avgDollarVolume20 = mean(hist);
  const projected = (dv[n - 1] ?? 0) / s.sessionFraction;
  const relVolume = avgDollarVolume20 ? projected / avgDollarVolume20 : 0;

  const mfv = bars.map((b, i) => mfm(b, bars[i - 1]?.c) * b.c * b.v);
  // La vela en curso se proyecta igual que el volumen para no infravalorarla intradía.
  mfv[n - 1] = (mfv[n - 1] ?? 0) / s.sessionFraction;
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const netFlow5d = sum(mfv.slice(-5));
  const netFlow20d = sum(mfv.slice(-20));
  const vol20 = sum(bars.slice(-20).map((b) => b.c * b.v));
  const cmf20 = vol20 ? netFlow20d / vol20 : 0;

  const price = isFinite(s.price) ? s.price : last.c;
  const chg1d = pct(price, s.previousClose);
  const chg5d = pct(price, closeAgo(5));
  const chg1m = pct(price, closeAgo(21));
  const chg3m = pct(price, closeAgo(63));

  const hasVolume = avgDollarVolume20 > 0;
  let flowScore: number;
  if (hasVolume) {
    const flowNorm = netFlow5d / avgDollarVolume20; // en "días de volumen medio"
    const volBoost = Math.min(2, Math.max(0.5, relVolume)); // el volumen inusual amplifica la señal
    flowScore =
      100 *
      (0.4 * Math.tanh(flowNorm / 1.5) * Math.sqrt(volBoost) +
        0.3 * Math.tanh(cmf20 * 5) +
        0.3 * Math.tanh(chg5d / 4));
  } else {
    // Sin volumen (índices, FX): solo momentum
    flowScore = 100 * (0.6 * Math.tanh(chg5d / 3) + 0.4 * Math.tanh(chg1m / 6));
  }
  flowScore = Math.max(-100, Math.min(100, flowScore));

  return {
    symbol: s.symbol,
    price,
    chg1d,
    chg5d,
    chg1m,
    chg3m,
    dollarVolume: projected,
    avgDollarVolume20,
    relVolume,
    cmf20,
    netFlow5d,
    netFlow20d,
    flowScore: Math.round(flowScore * 10) / 10,
    signal: signalOf(flowScore),
    asOf: new Date(s.marketTime * 1000).toISOString(),
  };
}

export function signalOf(score: number): FlowMetrics["signal"] {
  if (score >= 45) return "Entrada fuerte";
  if (score >= 15) return "Entrada";
  if (score <= -45) return "Salida fuerte";
  if (score <= -15) return "Salida";
  return "Neutral";
}

/** Valor de la serie en o antes de `daysAgo` días respecto al último punto. */
export function valueDaysAgo(series: Point[], daysAgo: number): number | undefined {
  if (!series.length) return undefined;
  const lastT = Date.parse(series[series.length - 1].date);
  const target = lastT - daysAgo * 86_400_000;
  for (let i = series.length - 1; i >= 0; i--) {
    if (Date.parse(series[i].date) <= target) return series[i].value;
  }
  return series[0].value;
}

export const change = (series: Point[], days: number) => {
  const now = series.at(-1)?.value;
  const then = valueDaysAgo(series, days);
  return now != null && then != null ? now - then : undefined;
};

export const changePct = (series: Point[], days: number) => {
  const now = series.at(-1)?.value;
  const then = valueDaysAgo(series, days);
  return now != null && then ? ((now - then) / then) * 100 : undefined;
};
