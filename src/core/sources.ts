import { cached, getJson, getText } from "./http.js";

/* ------------------------------------------------------------------ */
/* Yahoo Finance — precios y volumen OHLCV (acciones, ETFs, FX, cripto) */
/* ------------------------------------------------------------------ */

export interface Bar {
  t: number; // epoch segundos
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Series {
  symbol: string;
  currency: string;
  exchangeTz: string;
  price: number;
  previousClose: number;
  marketTime: number;
  /** Fracción transcurrida de la sesión regular (1 = cerrada / fuera de horario) */
  sessionFraction: number;
  bars: Bar[];
}

export async function yahooSeries(symbol: string, range = "6mo", interval = "1d"): Promise<Series> {
  return cached(`yf:${symbol}:${range}:${interval}`, 60_000, async () => {
    const hosts = ["query1", "query2"];
    let data: any;
    let lastErr: unknown;
    for (const host of hosts) {
      try {
        data = await getJson(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
          { retries: 2 },
        );
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    const r = data?.chart?.result?.[0];
    if (!r) throw lastErr ?? new Error(`Sin datos para ${symbol}`);
    const q = r.indicators?.quote?.[0] ?? {};
    const ts: number[] = r.timestamp ?? [];
    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null || !isFinite(c)) continue;
      bars.push({ t: ts[i], o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? 0 });
    }
    const meta = r.meta ?? {};
    const reg = meta.currentTradingPeriod?.regular;
    const now = Date.now() / 1000;
    let sessionFraction = 1;
    if (reg && now > reg.start && now < reg.end && meta.instrumentType !== "CRYPTOCURRENCY") {
      sessionFraction = Math.max(0.05, (now - reg.start) / (reg.end - reg.start));
    }
    const price = meta.regularMarketPrice ?? bars.at(-1)?.c ?? NaN;
    const previousClose = bars.length >= 2 ? bars[bars.length - 2].c : meta.chartPreviousClose ?? price;
    return {
      symbol,
      currency: meta.currency ?? "USD",
      exchangeTz: meta.exchangeTimezoneName ?? "",
      price,
      previousClose,
      marketTime: meta.regularMarketTime ?? bars.at(-1)?.t ?? 0,
      sessionFraction,
      bars,
    };
  });
}

/* ------------------------------------------------------------------ */
/* FRED (Reserva Federal de St. Louis) — liquidez del banco central     */
/* ------------------------------------------------------------------ */

export interface Point {
  date: string;
  value: number;
}

export async function fredSeries(id: string, start?: string): Promise<Point[]> {
  return cached(`fred:${id}:${start ?? ""}`, 3_600_000, async () => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}${start ? `&cosd=${start}` : ""}`;
    const csv = await getText(url, { timeoutMs: 20000 });
    return csv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const [date, v] = line.split(",");
        return { date, value: Number(v) };
      })
      .filter((p) => p.date && isFinite(p.value));
  });
}

/* ------------------------------------------------------------------ */
/* Cripto — CoinGecko, DefiLlama (stablecoins), alternative.me          */
/* ------------------------------------------------------------------ */

export interface CryptoGlobal {
  totalMarketCapUsd: number;
  totalVolumeUsd: number;
  marketCapChange24hPct: number;
  btcDominance: number;
  ethDominance: number;
  stablecoinDominance: number;
}

export async function cryptoGlobal(): Promise<CryptoGlobal> {
  return cached("cg:global", 120_000, async () => {
    const d = (await getJson("https://api.coingecko.com/api/v3/global")).data;
    const pct = d.market_cap_percentage ?? {};
    return {
      totalMarketCapUsd: d.total_market_cap?.usd,
      totalVolumeUsd: d.total_volume?.usd,
      marketCapChange24hPct: d.market_cap_change_percentage_24h_usd,
      btcDominance: pct.btc,
      ethDominance: pct.eth,
      stablecoinDominance: (pct.usdt ?? 0) + (pct.usdc ?? 0) + (pct.dai ?? 0) + (pct.usde ?? 0),
    };
  });
}

/** Oferta total de stablecoins en USD (proxy de liquidez "seca" lista para entrar al mercado cripto). */
export async function stablecoinSupply(): Promise<Point[]> {
  return cached("llama:stables", 1_800_000, async () => {
    const rows: any[] = await getJson("https://stablecoins.llama.fi/stablecoincharts/all", { timeoutMs: 30000 });
    return rows
      .map((r) => ({
        date: new Date(Number(r.date) * 1000).toISOString().slice(0, 10),
        value: Number(r.totalCirculatingUSD?.peggedUSD ?? 0),
      }))
      .filter((p) => p.value > 0);
  });
}

export async function fearGreed(limit = 30): Promise<{ value: number; label: string; date: string }[]> {
  return cached(`fng:${limit}`, 900_000, async () => {
    const d = await getJson(`https://api.alternative.me/fng/?limit=${limit}`);
    return (d.data ?? []).map((x: any) => ({
      value: Number(x.value),
      label: x.value_classification,
      date: new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10),
    }));
  });
}
