import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeFlow } from "./core/analytics.js";
import { cryptoGlobal, fearGreed, stablecoinSupply, yahooSeries } from "./core/sources.js";
import { buildLiquidity, buildSnapshot, computeRegime, fedLiquidity, type InstrumentFlow } from "./core/snapshot.js";
import { GROUP_LABELS, UNIVERSE } from "./core/universe.js";

export const VERSION = "1.0.0";

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
});

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
        "liquidez neta de la Reserva Federal, M2, oferta de stablecoins y sentimiento. Empieza por get_liquidity_overview.",
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
        const series = await yahooSeries(sym);
        const f = computeFlow(series);
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
          const f = computeFlow(await yahooSeries(sym));
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
              "get_fed_liquidity y get_crypto_liquidity) y redacta un informe claro en español: régimen de mercado, hacia dónde " +
              "fluye el dinero y de dónde sale, rotación geográfica y sectorial, contexto de liquidez de bancos centrales y cripto, " +
              "y los riesgos a vigilar. No es asesoramiento financiero.",
          },
        },
      ],
    }),
  );

  return server;
}
