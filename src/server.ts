import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { blendTradingView, computeFlow } from "./core/analytics.js";
import { cryptoGlobal, fearGreed, stablecoinSupply, yahooSeries } from "./core/sources.js";
import { buildLiquidity, buildSnapshot, computeRegime, fedLiquidity, type InstrumentFlow } from "./core/snapshot.js";
import { TV_MARKETS, tvQuotes, tvSectorBreadth, tvUnusualVolume } from "./core/tradingview.js";
import { GROUP_LABELS, UNIVERSE } from "./core/universe.js";

export const VERSION = "1.1.0";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

const compact = (i: InstrumentFlow) => ({
  simbolo: i.symbol,
  nombre: i.name,
  precio: round(i.price, 4),
  "cambio_1d_%": round(i.chg1d),
  "cambio_5d_%": round(i.chg5d),
  "cambio_1m_%": round(i.chg1m),
  volumen_relativo: round(i.relVolume),
  cmf20: round(i.cmf20, 3),
  flujo_neto_5d_usd: Math.round(i.netFlow5d),
  puntuacion_flujo: i.flowScore,
  señal: i.signal,
  ...(i.tv && {
    tradingview: {
      ticker: i.tv.ticker,
      calificacion: round(i.tv.rating ?? undefined, 3),
      recomendacion: i.tv.ratingLabel,
      rsi: round(i.tv.rsi ?? undefined, 1),
      volumen_relativo_10d: round(i.tv.relVolume10d ?? undefined),
      confirma_flujo: i.tvConfirms ?? null,
    },
  }),
});

/** Flujo de un símbolo con Yahoo (volumen) + TradingView (técnico). */
async function flowFor(sym: string) {
  const [series, tv] = await Promise.all([yahooSeries(sym), tvQuotes([sym]).catch(() => new Map())]);
  return { series, flow: blendTradingView(computeFlow(series), tv.get(sym)) };
}

function round(x: number | undefined, d = 2) {
  return x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "volumen", version: VERSION },
    {
      instructions:
        "Volumen analiza en tiempo casi real hacia dónde se mueve la liquidez global: flujos de dinero por clase de activo, " +
        "región, sector y cripto (volumen en USD, Chaikin Money Flow, volumen relativo), régimen risk-on/risk-off, " +
        "liquidez neta de la Reserva Federal, M2, oferta de stablecoins y sentimiento, más análisis técnico, volumen inusual y " +
        "amplitud sectorial de TradingView. Empieza por get_liquidity_overview.",
    },
  );

  server.registerTool(
    "get_liquidity_overview",
    {
      title: "Panorama global de liquidez",
      description:
        "Resumen completo: régimen de mercado, hacia dónde entra y de dónde sale el dinero (top entradas/salidas), " +
        "liquidez de la Fed, stablecoins, cripto y un resumen narrativo en español.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const s = await buildSnapshot();
        return json({
          generado: s.generatedAt,
          resumen: s.narrative,
          regimen: s.regime,
          top_entradas: s.topInflows.map(compact),
          top_salidas: s.topOutflows.map(compact),
          tradingview: s.tradingview && {
            volumen_inusual_eeuu: s.tradingview.unusualVolume.slice(0, 10),
            volumen_cripto: s.tradingview.cryptoUnusual.slice(0, 10),
            amplitud_sectorial: s.tradingview.sectorBreadth,
          },
          liquidez: {
            fed: s.liquidity.fed && { ...s.liquidity.fed, series: undefined },
            m2: s.liquidity.m2,
            stablecoins: s.liquidity.stablecoins && { ...s.liquidity.stablecoins, series: undefined },
            cripto: s.liquidity.crypto,
            miedo_codicia: s.liquidity.fearGreed && { valor: s.liquidity.fearGreed.value, etiqueta: s.liquidity.fearGreed.label },
          },
          errores_fuentes: s.errors,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_capital_flows",
    {
      title: "Flujos de capital por grupo",
      description:
        "Ranking de flujo de liquidez dentro de un grupo: 'asset' (clases de activo), 'region' (países), 'sector' (sectores EE.UU.), " +
        "'crypto' o 'macro' (índices y divisas). Ordenado de mayor entrada a mayor salida.",
      inputSchema: {
        group: z.enum(["asset", "region", "sector", "crypto", "macro"]).describe("Grupo a analizar"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ group }) => {
      try {
        const s = await buildSnapshot();
        return json({ grupo: GROUP_LABELS[group], generado: s.generatedAt, instrumentos: s.groups[group].map(compact) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "analyze_instrument",
    {
      title: "Analizar flujo de un instrumento",
      description:
        "Analiza el flujo de dinero de cualquier símbolo de Yahoo Finance (acciones, ETFs, índices como ^GSPC, divisas como EURUSD=X, " +
        "futuros como GC=F, cripto como BTC-USD): volumen en USD, volumen relativo, CMF, flujo neto y puntuación.",
      inputSchema: {
        symbol: z.string().min(1).describe("Símbolo de Yahoo Finance, p.ej. AAPL, EWZ, ^N225, BTC-USD"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const sym = symbol.trim().toUpperCase();
        const { series, flow: f } = await flowFor(sym);
        const inst = UNIVERSE.find((i) => i.symbol === sym);
        return json({
          ...compact({ ...f, name: inst?.name ?? sym, group: inst?.group ?? "asset" }),
          moneda: series.currency,
          "cambio_3m_%": round(f.chg3m),
          volumen_usd_sesion: Math.round(f.dollarVolume),
          volumen_usd_medio_20d: Math.round(f.avgDollarVolume20),
          flujo_neto_20d_usd: Math.round(f.netFlow20d),
          sesion_abierta: series.sessionFraction < 1,
          dato_a: f.asOf,
          ultimas_sesiones: series.bars.slice(-10).map((b) => ({
            fecha: new Date(b.t * 1000).toISOString().slice(0, 10),
            cierre: round(b.c, 4),
            volumen: b.v,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compare_flows",
    {
      title: "Comparar flujos",
      description: "Compara el flujo de liquidez entre varios símbolos (p.ej. ['GLD','TLT','SPY','BTC-USD']) y los ordena.",
      inputSchema: { symbols: z.array(z.string()).min(2).max(25).describe("Lista de símbolos de Yahoo Finance") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols }) => {
      const results = await Promise.allSettled(
        symbols.map(async (s) => {
          const sym = s.trim().toUpperCase();
          const { flow: f } = await flowFor(sym);
          return compact({ ...f, name: UNIVERSE.find((i) => i.symbol === sym)?.name ?? sym, group: "asset" });
        }),
      );
      const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const errs = results.flatMap((r, i) => (r.status === "rejected" ? [`${symbols[i]}: ${r.reason?.message}`] : []));
      ok.sort((a, b) => b.puntuacion_flujo - a.puntuacion_flujo);
      return json({ ranking: ok, errores: errs });
    },
  );

  server.registerTool(
    "get_risk_regime",
    {
      title: "Régimen risk-on / risk-off",
      description:
        "Determina si el dinero busca riesgo o refugio combinando flujo en activos de riesgo vs refugio, VIX, crédito (HYG vs IEF) y cobre/oro.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const s = await buildSnapshot();
        return json(computeRegime(s.groups));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_fed_liquidity",
    {
      title: "Liquidez neta de la Reserva Federal",
      description:
        "Liquidez neta en USD = balance de la Fed (WALCL) − cuenta del Tesoro (TGA) − repos inversos (RRP), en miles de millones, " +
        "con variaciones a 4, 13 y 52 semanas e historial semanal. Fuente: FRED.",
      inputSchema: { weeks: z.number().int().min(4).max(300).default(52).describe("Semanas de historial a devolver") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ weeks }) => {
      try {
        const f = await fedLiquidity();
        return json({ ...f, series: f.series.slice(-weeks), unidad: "miles de millones USD" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_crypto_liquidity",
    {
      title: "Liquidez cripto",
      description:
        "Capitalización total, volumen y dominancias (CoinGecko), oferta de stablecoins y su variación (DefiLlama), " +
        "e índice de miedo y codicia (alternative.me).",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [g, st, fg] = await Promise.allSettled([cryptoGlobal(), stablecoinSupply(), fearGreed(30)]);
        const stables = st.status === "fulfilled" ? st.value : [];
        const liq = await buildLiquidity();
        return json({
          global: g.status === "fulfilled" ? g.value : null,
          stablecoins: liq.stablecoins && { ...liq.stablecoins, series: stables.slice(-30) },
          miedo_codicia: fg.status === "fulfilled" ? fg.value : null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tradingview_technicals",
    {
      title: "Análisis técnico de TradingView",
      description:
        "Calificación técnica de TradingView (−1 venta fuerte … +1 compra fuerte; medias móviles y osciladores), RSI, volumen " +
        "relativo 10d, valor negociado y rendimiento semanal/mensual. Acepta símbolos de EE.UU. (SPY, AAPL), de Yahoo " +
        "(BTC-USD, ^VIX, EURUSD=X, GC=F) o de TradingView con bolsa (BMV:WALMEX, BINANCE:SOLUSDT, TVC:DXY).",
      inputSchema: { symbols: z.array(z.string()).min(1).max(50).describe("Símbolos a consultar") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols }) => {
      try {
        const tv = await tvQuotes(symbols);
        return json({
          resultados: symbols.map((s) => {
            const t = tv.get(s);
            if (!t) return { simbolo: s, error: "No encontrado en TradingView" };
            return {
              simbolo: s,
              ticker: t.ticker,
              precio: t.close,
              "cambio_dia_%": round(t.change ?? undefined),
              calificacion: round(t.rating ?? undefined, 3),
              recomendacion: t.ratingLabel,
              medias_moviles: round(t.ratingMA ?? undefined, 3),
              osciladores: round(t.ratingOsc ?? undefined, 3),
              rsi: round(t.rsi ?? undefined, 1),
              volumen_relativo_10d: round(t.relVolume10d ?? undefined),
              valor_negociado_usd: t.valueTraded,
              "rend_semana_%": round(t.perfW ?? undefined),
              "rend_mes_%": round(t.perf1M ?? undefined),
            };
          }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tradingview_unusual_volume",
    {
      title: "Volumen inusual (TradingView)",
      description:
        "Screener de TradingView: activos con el volumen relativo más alto ahora mismo y liquidez suficiente — dónde está " +
        "entrando dinero nuevo. Mercados: america, crypto, mexico, brazil, argentina, chile, colombia, peru, uk, germany, " +
        "france, spain, japan, china, hongkong, india, korea, taiwan, canada, australia, etc.",
      inputSchema: {
        market: z.enum(TV_MARKETS).default("america").describe("Mercado de TradingView"),
        limit: z.number().int().min(5).max(50).default(20),
        min_value_traded: z.number().min(0).default(20_000_000).describe("Valor negociado mínimo de la sesión (moneda local)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ market, limit, min_value_traded }) => {
      try {
        const rows = await tvUnusualVolume(market, limit, min_value_traded);
        return json({
          mercado: market,
          nota: market === "crypto" ? "volumen_relativo = volumen 24h / 24h previas (todos los exchanges)" : "volumen_relativo = sesión / media 10 sesiones",
          resultados: rows,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tradingview_sector_breadth",
    {
      title: "Amplitud y flujo sectorial intradía (TradingView)",
      description:
        "Recorre todas las acciones de EE.UU. con capitalización > 10.000 M y calcula por sector: % de acciones al alza, " +
        "valor negociado y flujo neto intradía (valor negociado con el signo del movimiento). Medida bottom-up independiente de los ETFs.",
      inputSchema: { min_market_cap: z.number().min(0).default(10_000_000_000) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ min_market_cap }) => {
      try {
        return json({ sectores: await tvSectorBreadth(min_market_cap) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerResource(
    "snapshot",
    "volumen://snapshot",
    { title: "Snapshot completo de Volumen", description: "Todos los datos de flujos y liquidez en JSON", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await buildSnapshot()) }] }),
  );

  server.registerPrompt(
    "informe_liquidez",
    {
      title: "Informe de liquidez global",
      description: "Genera un informe sobre hacia dónde se dirige la liquidez mundial ahora mismo.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Usa las herramientas de Volumen (get_liquidity_overview, get_capital_flows para 'asset', 'region' y 'sector', " +
              "get_fed_liquidity, get_crypto_liquidity, tradingview_unusual_volume y tradingview_sector_breadth) y redacta un informe claro en español: régimen de mercado, hacia dónde " +
              "fluye el dinero y de dónde sale, rotación geográfica y sectorial, contexto de liquidez de bancos centrales y cripto, " +
              "y los riesgos a vigilar. No es asesoramiento financiero.",
          },
        },
      ],
    }),
  );

  return server;
}
