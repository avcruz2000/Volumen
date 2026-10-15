/**
 * Genera site/data/snapshot.json y site/data/history.json para el dashboard público.
 * Lo ejecuta GitHub Actions cada pocos minutos. El historial se reconstruye leyendo
 * el history.json ya publicado (variable PUBLISHED_URL), así no hace falta commitear datos.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { buildSnapshot } from "../src/core/snapshot.js";

const OUT = new URL("../../site/data/", import.meta.url);
const MAX_POINTS = 2000; // ~2 semanas a 10 min

interface HistoryPoint {
  t: string;
  regime: number;
  scores: Record<string, number>;
}

async function previousHistory(): Promise<HistoryPoint[]> {
  const base = process.env.PUBLISHED_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/data/history.json?ts=${Date.now()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const snap = await buildSnapshot();
const history = await previousHistory();
const scores: Record<string, number> = {};
for (const g of ["asset", "region", "sector", "crypto"] as const) {
  for (const i of snap.groups[g]) scores[i.symbol] = i.flowScore;
}
history.push({ t: snap.generatedAt, regime: snap.regime.score, scores });

await mkdir(OUT, { recursive: true });
await writeFile(new URL("snapshot.json", OUT), JSON.stringify(snap));
await writeFile(new URL("history.json", OUT), JSON.stringify(history.slice(-MAX_POINTS)));

const n = Object.values(snap.groups).reduce((a, g) => a + g.length, 0);
console.log(`Snapshot ${snap.generatedAt}: ${n} instrumentos, régimen ${snap.regime.label} (${snap.regime.score}), ${snap.errors.length} errores`);
if (snap.errors.length) console.log(snap.errors.join("\n"));
if (n < 20) {
  console.error("Demasiados fallos en las fuentes; se aborta para no publicar un snapshot vacío.");
  process.exit(1);
}
