/**
 * Genera site/data/history/*.json con todo el historial de flujos (mensual y semanal) y macro.
 * Es pesado (descarga ~30 años de datos diarios por instrumento), así que solo se recalcula
 * una vez al día; en el resto de ejecuciones se reutilizan los archivos ya publicados.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { buildGroupHistory, buildMacroHistory, regimeHistory, type GroupHistory } from "../src/core/history.js";
import type { Group } from "../src/core/universe.js";

const OUT = new URL("../../site/data/history/", import.meta.url);
const GROUPS: Group[] = ["asset", "region", "sector", "crypto"];
const MAX_AGE_H = 20;
const WEEKLY_PERIODS = 520; // 10 años de semanas
const VERSION = 1;

const files = [...GROUPS.flatMap((g) => [`${g}-monthly.json`, `${g}-weekly.json`]), "macro.json", "regime.json", "meta.json"];

async function reusePublished(): Promise<boolean> {
  const base = process.env.PUBLISHED_URL?.replace(/\/$/, "");
  if (!base || process.env.HISTORY_FORCE === "1") return false;
  try {
    const meta = await (await fetch(`${base}/data/history/meta.json?ts=${Date.now()}`)).json();
    const ageH = (Date.now() - Date.parse(meta.generatedAt)) / 3_600_000;
    if (meta.version !== VERSION || !(ageH < MAX_AGE_H)) return false;
    await mkdir(OUT, { recursive: true });
    for (const f of files) {
      const res = await fetch(`${base}/data/history/${f}`);
      if (!res.ok) return false;
      await writeFile(new URL(f, OUT), Buffer.from(await res.arrayBuffer()));
    }
    console.log(`Historial reutilizado (generado hace ${ageH.toFixed(1)} h)`);
    return true;
  } catch {
    return false;
  }
}

if (!(await reusePublished())) {
  const errors: string[] = [];
  await mkdir(OUT, { recursive: true });
  const monthly: Partial<Record<Group, GroupHistory>> = {};
  const summary: Record<string, { from: string; to: string; series: number }> = {};
  for (const g of GROUPS) {
    const m = await buildGroupHistory(g, "monthly", { errors });
    const w = await buildGroupHistory(g, "weekly", { maxPeriods: WEEKLY_PERIODS, errors });
    monthly[g] = m;
    await writeFile(new URL(`${g}-monthly.json`, OUT), JSON.stringify(m));
    await writeFile(new URL(`${g}-weekly.json`, OUT), JSON.stringify(w));
    summary[g] = { from: m.periods[0], to: m.periods.at(-1)!, series: m.series.length };
    console.log(`${g}: ${m.series.length} series, ${m.periods[0]} → ${m.periods.at(-1)}`);
  }
  const regime = regimeHistory(monthly.asset!, monthly.sector!);
  await writeFile(new URL("regime.json", OUT), JSON.stringify(regime));
  const macro = await buildMacroHistory(errors);
  await writeFile(new URL("macro.json", OUT), JSON.stringify(macro));
  await writeFile(new URL("meta.json", OUT), JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), groups: summary, errors }));
  if (errors.length) console.log("Errores:\n" + errors.join("\n"));
}
