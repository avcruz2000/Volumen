/**
 * TradingView — scanner público (scanner.tradingview.com).
 * Aporta: calificación técnica agregada (osciladores + medias), RSI, volumen relativo intradía,
 * valor negociado en USD de la sesión y screeners de volumen inusual / amplitud sectorial.
 */
import { cached } from "./http.js";

const SCAN = "https://scanner.tradingview.com";

const FIELDS = [
  "name",
  "description",
  "close",
  "change",
  "Recommend.All",
  "Recommend.MA",
  "Recommend.Other",
  "RSI",
  "relative_volume_10d_calc",
  "Value.Traded",
  "Perf.W",
  "Perf.1M",
] as const;

export interface TvData {
  ticker: string; // p.ej. AMEX:SPY
  close: number | null;
  change: number | null; // % del día
  rating: number | null; // -1 venta fuerte … +1 compra fuerte
  ratingMA: number | null;
  ratingOsc: number | null;
  ratingLabel: string;
  rsi: number | null;
  relVolume10d: number | null;
  valueTraded: number | null; // USD negociados en la sesión
  perfW: number | null;
  perf1M: number | null;
}

/** Símbolos Yahoo que no son ETFs/acciones de EE.UU. → ticker de TradingView. */
const EXPLICIT: Record<string, string> = {
  "BTC-USD": "COINBASE:BTCUSD",
  "ETH-USD": "COINBASE:ETHUSD",
  "SOL-USD": "COINBASE:SOLUSD",
  "XRP-USD": "COINBASE:XRPUSD",
  "BNB-USD": "BINANCE:BNBUSDT",
  "DOGE-USD": "COINBASE:DOGEUSD",
  "^VIX": "TVC:VIX",
  "^TNX": "TVC:US10Y",
  "^IRX": "TVC:US03MY",
  "DX-Y.NYB": "TVC:DXY",
  "EURUSD=X": "FX:EURUSD",
  "JPY=X": "FX:USDJPY",
  "CNY=X": "FX_IDC:USDCNY",
  "MXN=X": "FX:USDMXN",
  "GC=F": "COMEX:GC1!",
  "CL=F": "NYMEX:CL1!",
  "HG=F": "COMEX:HG1!",
};

export function ratingLabel(r: number | null | undefined): string {
  if (r == null || !isFinite(r)) return "Sin dato";
  if (r >= 0.5) return "Compra fuerte";
  if (r >= 0.1) return "Compra";
  if (r > -0.1) return "Neutral";
  if (r > -0.5) return "Venta";
  return "Venta fuerte";
}

async function post(market: string, body: unknown): Promise<{ s: string; d: any[] }[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SCAN}/${market}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Origin: "https://www.tradingview.com" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return ((await res.json()).data ?? []) as { s: string; d: any[] }[];
      lastErr = new Error(`TradingView HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const num = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : null);

function toTv(row: { s: string; d: any[] }, cols: readonly string[]): TvData {
  const g = (k: string) => num(row.d[cols.indexOf(k)]);
  const rating = g("Recommend.All");
  return {
    ticker: row.s,
    close: g("close"),
    change: g("change"),
    rating,
    ratingMA: g("Recommend.MA"),
    ratingOsc: g("Recommend.Other"),
    ratingLabel: ratingLabel(rating),
    rsi: g("RSI"),
    relVolume10d: g("relative_volume_10d_calc"),
    valueTraded: g("Value.Traded"),
    perfW: g("Perf.W"),
    perf1M: g("Perf.1M"),
  };
}

const isTvTicker = (s: string) => s.includes(":");
const isUsListed = (s: string) => /^[A-Z.]{1,6}$/.test(s);

/**
 * Datos de TradingView para una lista de símbolos (formato Yahoo o TradingView "EXCHANGE:TICKER").
 * Devuelve un mapa símbolo-original → datos. Los que no se encuentran se omiten.
 */
export async function tvQuotes(symbols: string[]): Promise<Map<string, TvData>> {
  const key = `tv:${[...symbols].sort().join(",")}`;
  return cached(key, 60_000, async () => {
    const out = new Map<string, TvData>();
    const explicit = new Map<string, string>(); // tvTicker → original
    const usNames: string[] = [];
    for (const s of symbols) {
      const up = s.toUpperCase();
      if (isTvTicker(up)) explicit.set(up, s);
      else if (EXPLICIT[up]) explicit.set(EXPLICIT[up], s);
      else if (isUsListed(up)) usNames.push(up.replace(".", "_"));
    }
    const jobs: Promise<void>[] = [];
    if (explicit.size) {
      jobs.push(
        post("global", { symbols: { tickers: [...explicit.keys()] }, columns: FIELDS }).then((rows) => {
          for (const r of rows) {
            const orig = explicit.get(r.s);
            if (orig) out.set(orig, toTv(r, FIELDS));
          }
        }),
      );
    }
    if (usNames.length) {
      // Buscamos por nombre en EE.UU.; si un nombre existe en varias bolsas nos quedamos con el más negociado.
      jobs.push(
        post("america", {
          filter: [
            { left: "name", operation: "in_range", right: usNames },
            { left: "exchange", operation: "in_range", right: ["AMEX", "NASDAQ", "NYSE", "CBOE"] },
          ],
          columns: FIELDS,
          range: [0, usNames.length * 3],
        }).then((rows) => {
          const best = new Map<string, TvData>();
          for (const r of rows) {
            const t = toTv(r, FIELDS);
            const name = String(r.d[0]).replace("_", ".");
            const prev = best.get(name);
            if (!prev || (t.valueTraded ?? 0) > (prev.valueTraded ?? 0)) best.set(name, t);
          }
          for (const s of symbols) {
            const t = best.get(s.toUpperCase());
            if (t) out.set(s, t);
          }
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Screeners                                                            */
/* ------------------------------------------------------------------ */

export interface UnusualVolume {
  ticker: string;
  name: string;
  description: string;
  sector: string;
  close: number | null;
  change: number | null;
  relVolume10d: number | null;
  valueTraded: number | null;
  marketCap: number | null;
  rating: number | null;
  ratingLabel: string;
}

const SCREEN_COLS = ["name", "description", "sector", "close", "change", "relative_volume_10d_calc", "Value.Traded", "market_cap_basic", "Recommend.All"];

const US_EXCHANGES = { left: "exchange", operation: "in_range", right: ["AMEX", "NASDAQ", "NYSE"] };

/** Mercados de TradingView admitidos por el screener (los más líquidos). */
export const TV_MARKETS = ["america", "crypto", "mexico", "brazil", "argentina", "chile", "colombia", "peru",
  "uk", "germany", "france", "spain", "italy", "switzerland", "japan", "china", "hongkong", "taiwan", "korea", "india",
  "australia", "canada", "ksa", "turkey", "rsa", "israel"] as const;

/**
 * Acciones con volumen inusual (volumen relativo 10d más alto) y suficiente liquidez.
 * Señala dónde está entrando dinero nuevo ahora mismo.
 */
export async function tvUnusualVolume(market = "america", limit = 20, minValueTraded = 20_000_000): Promise<UnusualVolume[]> {
  return cached(`tv:unusual:${market}:${limit}:${minValueTraded}`, 120_000, async () => {
    const filter: unknown[] = [
      { left: "Value.Traded", operation: "greater", right: minValueTraded },
      { left: "relative_volume_10d_calc", operation: "greater", right: 1.2 },
    ];
    if (market === "crypto") return tvCryptoVolume(limit);
    if (market === "america")
      filter.push(US_EXCHANGES, { left: "type", operation: "in_range", right: ["stock", "fund", "dr"] }, { left: "market_cap_basic", operation: "greater", right: 2_000_000_000 }, { left: "typespecs", operation: "has_none_of", right: ["preferred"] });
    else
      // Solo cotizaciones primarias: evita ETFs extranjeros cruzados (p.ej. el SIC mexicano).
      filter.push({ left: "type", operation: "in_range", right: ["stock", "fund", "dr"] }, { left: "is_primary", operation: "equal", right: true });
    const rows = await post(market, {
      filter,
      columns: SCREEN_COLS,
      sort: { sortBy: "relative_volume_10d_calc", sortOrder: "desc" },
      range: [0, limit * 2],
    });
    // Fuera clases preferentes / unidades ("NEE/PS", "PCG/PX").
    return rows.filter((r) => market !== "america" || !String(r.d[0]).includes("/")).slice(0, limit).map((r) => {
      const d = r.d;
      const rating = num(d[8]);
      return {
        ticker: r.s,
        name: String(d[0]),
        description: String(d[1] ?? ""),
        sector: String(d[2] ?? ""),
        close: num(d[3]),
        change: num(d[4]),
        relVolume10d: num(d[5]),
        valueTraded: num(d[6]),
        marketCap: num(d[7]),
        rating,
        ratingLabel: ratingLabel(rating),
      };
    });
  });
}

/**
 * Cripto con mayor aumento de volumen en 24h (mercado "coin" de TradingView, datos agregados de todos los exchanges).
 * relVolume10d aquí = volumen 24h / volumen de las 24h previas.
 */
export async function tvCryptoVolume(limit = 10, minMarketCap = 500_000_000): Promise<UnusualVolume[]> {
  return cached(`tv:coin:${limit}:${minMarketCap}`, 120_000, async () => {
    const rows = await post("coin", {
      filter: [
        { left: "market_cap_calc", operation: "greater", right: minMarketCap },
        { left: "24h_vol_cmc", operation: "greater", right: 20_000_000 },
      ],
      columns: ["name", "description", "close", "24h_close_change|5", "24h_vol_cmc", "market_cap_calc", "24h_vol_change_cmc", "Recommend.All"],
      sort: { sortBy: "24h_vol_change_cmc", sortOrder: "desc" },
      range: [0, limit * 4],
    });
    // Fuera stablecoins y tokens envueltos / de staking: no representan dinero nuevo en riesgo.
    const derivative = /wrapped|staked|bridged|restak|liquid|stable|usd|eur|gold|bitcoin \(|ether\.fi|lombard/i;
    return rows.filter((r) => !derivative.test(String(r.d[1] ?? "")) && !/^W[A-Z]|USD[CT]?$|^ST/.test(String(r.d[0]).replace(/USD$/, ""))).slice(0, limit).map((r) => {
      const d = r.d;
      const rating = num(d[7]);
      const volChg = num(d[6]);
      return {
        ticker: r.s,
        name: String(d[0]).replace(/USD$/, ""),
        description: String(d[1] ?? ""),
        sector: "Cripto",
        close: num(d[2]),
        change: num(d[3]),
        relVolume10d: volChg == null ? null : 1 + volChg / 100,
        valueTraded: num(d[4]),
        marketCap: num(d[5]),
        rating,
        ratingLabel: ratingLabel(rating),
      };
    });
  });
}

export interface SectorBreadth {
  sector: string;
  stocks: number;
  advancingPct: number; // % de acciones en positivo hoy
  netFlowUsd: number; // Σ valor negociado × dirección del día
  valueTradedUsd: number;
  flowRatio: number; // netFlow / valor negociado (-1..1)
}

/**
 * Amplitud y flujo intradía por sector usando todas las acciones de EE.UU. > 10.000 M de capitalización.
 * Es una medida "bottom-up" independiente de los ETFs sectoriales.
 */
export async function tvSectorBreadth(minMarketCap = 10_000_000_000): Promise<SectorBreadth[]> {
  return cached(`tv:breadth:${minMarketCap}`, 120_000, async () => {
    const rows = await post("america", {
      filter: [
        { left: "market_cap_basic", operation: "greater", right: minMarketCap },
        { left: "type", operation: "equal", right: "stock" },
        US_EXCHANGES,
      ],
      columns: ["sector", "change", "Value.Traded"],
      range: [0, 2000],
    });
    const agg = new Map<string, { n: number; up: number; net: number; vt: number }>();
    for (const r of rows) {
      const [sector, change, vt] = r.d as [string, number, number];
      if (!sector || !isFinite(change) || !isFinite(vt)) continue;
      const a = agg.get(sector) ?? { n: 0, up: 0, net: 0, vt: 0 };
      a.n++;
      if (change > 0) a.up++;
      a.net += vt * Math.tanh(change); // ±1% de movimiento ≈ 76% del valor negociado con signo
      a.vt += vt;
      agg.set(sector, a);
    }
    return [...agg.entries()]
      .filter(([, a]) => a.n >= 5)
      .map(([sector, a]) => ({
        sector: SECTOR_ES[sector] ?? sector,
        stocks: a.n,
        advancingPct: (a.up / a.n) * 100,
        netFlowUsd: a.net,
        valueTradedUsd: a.vt,
        flowRatio: a.vt ? a.net / a.vt : 0,
      }))
      .sort((x, y) => y.flowRatio - x.flowRatio);
  });
}

const SECTOR_ES: Record<string, string> = {
  "Electronic Technology": "Tecnología electrónica",
  "Technology Services": "Servicios tecnológicos",
  Finance: "Finanzas",
  "Health Technology": "Tecnología sanitaria",
  "Health Services": "Servicios de salud",
  "Retail Trade": "Comercio minorista",
  "Consumer Non-Durables": "Consumo no duradero",
  "Consumer Durables": "Consumo duradero",
  "Consumer Services": "Servicios al consumidor",
  "Energy Minerals": "Energía",
  "Non-Energy Minerals": "Minería (no energía)",
  "Producer Manufacturing": "Manufactura industrial",
  "Process Industries": "Industria de procesos",
  Utilities: "Utilities",
  Transportation: "Transporte",
  Communications: "Comunicaciones",
  "Commercial Services": "Servicios comerciales",
  "Industrial Services": "Servicios industriales",
  "Distribution Services": "Distribución",
  Miscellaneous: "Varios",
};
