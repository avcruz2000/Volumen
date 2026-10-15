/* Volumen — dashboard público.
 * Capa 1: snapshot.json generado por GitHub Actions cada ~10 min (o /api/snapshot de un servidor propio con ?api=URL).
 * Capa 2: datos en vivo desde el navegador (Coinbase WebSocket + CoinGecko). */
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const API = params.get("api"); // p.ej. ?api=https://mi-servidor.com → tiempo real total
  const SNAPSHOT_URL = API ? `${API.replace(/\/$/, "")}/api/snapshot` : "data/snapshot.json";
  const HISTORY_URL = "data/history.json";
  const REFRESH_MS = 60_000;

  const $ = (s) => document.querySelector(s);
  const tip = $("#tip");
  let snap = null;
  let history = [];
  let currentGroup = "asset";
  let showTable = false;

  /* ---------- tema ---------- */
  try {
    const saved = localStorage.getItem("volumen-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {}
  $("#themeBtn").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("volumen-theme", next); } catch {}
    renderAll();
  });

  /* ---------- formato ---------- */
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmtPct = (x, d = 2) => (x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}%`);
  const fmtUsd = (x) => {
    if (x == null || !isFinite(x)) return "—";
    const a = Math.abs(x), s = x < 0 ? "−" : "";
    if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)} bill.`;
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)} mil M`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(0)} M`;
    return `${s}$${a.toLocaleString("es")}`;
  };
  const fmtPrice = (x) => (x == null ? "—" : x >= 1000 ? x.toLocaleString("es", { maximumFractionDigits: 0 }) : x >= 10 ? x.toFixed(2) : x.toFixed(4));
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function divergingColor(score) {
    const t = Math.max(-1, Math.min(1, score / 70));
    return t >= 0 ? d3.interpolateRgb(css("--mid"), css("--in"))(t) : d3.interpolateRgb(css("--mid"), css("--out"))(-t);
  }

  /* ---------- tooltip ---------- */
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => (tip.hidden = true);
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  const instTip = (d) =>
    `<div class="t">${esc(d.name)} <span class="muted">${esc(d.symbol)}</span></div>` +
    kv("Puntuación flujo", `${d.flowScore > 0 ? "+" : ""}${d.flowScore.toFixed(1)}`) +
    kv("Señal", d.signal) +
    kv("Precio", fmtPrice(d.price)) +
    kv("Cambio 1d / 5d", `${fmtPct(d.chg1d)} / ${fmtPct(d.chg5d)}`) +
    kv("Cambio 1m", fmtPct(d.chg1m)) +
    (d.avgDollarVolume20 > 0
      ? kv("Volumen relativo", `${d.relVolume.toFixed(2)}×`) + kv("Flujo neto 5d", fmtUsd(d.netFlow5d)) + kv("CMF 20", d.cmf20.toFixed(3))
      : "");

  /* ---------- tiles ---------- */
  function renderTiles() {
    const r = snap.regime, L = snap.liquidity, vix = r.components.vix;
    const pos = ((r.score + 100) / 200) * 100;
    const tiles = [
      { lbl: "Régimen de mercado", val: r.label, delta: `Puntuación ${r.score > 0 ? "+" : ""}${Math.round(r.score)}`, gauge: pos, small: true },
      L.fed && {
        lbl: "Liquidez neta Fed",
        val: `$${(L.fed.latest / 1000).toFixed(2)} bill.`,
        delta: `<span class="${cls(L.fed.chg4w)}">${L.fed.chg4w > 0 ? "▲" : "▼"} ${Math.abs(L.fed.chg4w ?? 0).toFixed(0)} mil M</span> en 4 sem.`,
      },
      L.stablecoins && {
        lbl: "Stablecoins en circulación",
        val: fmtUsd(L.stablecoins.latest),
        delta: `<span class="${cls(L.stablecoins.chg30d)}">${L.stablecoins.chg30d >= 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(L.stablecoins.chg30d))}</span> en 30 días`,
      },
      L.crypto && {
        id: "cryptoTile",
        lbl: "Capitalización cripto",
        val: fmtUsd(L.crypto.totalMarketCapUsd),
        delta: `<span class="${cls(L.crypto.marketCapChange24hPct)}">${fmtPct(L.crypto.marketCapChange24hPct)}</span> 24h · BTC ${L.crypto.btcDominance.toFixed(1)}%`,
      },
      vix != null && { lbl: "VIX (miedo bursátil)", val: vix.toFixed(2), delta: vix > 25 ? "Estrés elevado" : vix < 15 ? "Complacencia" : "Normal" },
      L.fearGreed && { lbl: "Miedo y codicia cripto", val: L.fearGreed.value, delta: L.fearGreed.label, gauge: L.fearGreed.value },
      L.m2 && { lbl: "Masa monetaria M2 (EE.UU.)", val: `$${(L.m2.latest / 1000).toFixed(2)} bill.`, delta: `<span class="${cls(L.m2.yoyPct)}">${fmtPct(L.m2.yoyPct, 1)}</span> interanual` },
    ].filter(Boolean);
    $("#tiles").innerHTML = tiles
      .map(
        (t) => `<div class="tile"${t.id ? ` id="${t.id}"` : ""}><div class="lbl">${t.lbl}</div>
        <div class="val ${t.small ? "" : "num"}" style="${t.small ? "font-size:20px" : ""}">${t.val}</div>
        <div class="delta">${t.delta}</div>${t.gauge != null ? `<div class="gauge"><i style="left:${t.gauge}%"></i></div>` : ""}</div>`,
      )
      .join("");
  }

  /* ---------- barras divergentes ---------- */
  function barChart(el, data, { fixedDomain = 100 } = {}) {
    const node = typeof el === "string" ? $(el) : el;
    node.innerHTML = "";
    if (!data.length) return (node.innerHTML = '<p class="muted">Sin datos.</p>');
    const W = node.clientWidth || 600;
    const rowH = 26, labelW = Math.min(190, W * 0.38), valW = 44;
    const m = { t: 4, r: valW, b: 22, l: labelW };
    const H = m.t + m.b + data.length * rowH;
    const x = d3.scaleLinear().domain([-fixedDomain, fixedDomain]).range([m.l, W - m.r]);
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img");
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(W < 500 ? 4 : 8).tickSize(-(H - m.t - m.b)).tickFormat((d) => (d > 0 ? `+${d}` : d)))
      .call((g) => g.select(".domain").remove());
    const rows = svg.selectAll(".row").data(data).join("g").attr("class", "row")
      .attr("transform", (_, i) => `translate(0,${m.t + i * rowH})`);
    const bh = 14, y0 = (rowH - bh) / 2;
    rows.append("path").attr("class", "bar").attr("fill", (d) => (d.flowScore >= 0 ? css("--in") : css("--out")))
      .attr("d", (d) => {
        const a = x(0), b = x(Math.max(-fixedDomain, Math.min(fixedDomain, d.flowScore)));
        const w = Math.abs(b - a), r = Math.min(4, w);
        if (w < 0.5) return "";
        return d.flowScore >= 0
          ? `M${a},${y0}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${bh - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`
          : `M${a},${y0}h-${w - r}a${r},${r} 0 0 0 -${r},${r}v${bh - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${w - r}z`;
      });
    rows.append("text").attr("class", "bar-label").attr("x", m.l - 8).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end")
      .text((d) => (d.name.length > 26 && W < 520 ? d.name.slice(0, 24) + "…" : d.name));
    rows.append("text").attr("class", "bar-val").attr("x", W - m.r + 6).attr("y", rowH / 2).attr("dy", "0.35em")
      .text((d) => `${d.flowScore > 0 ? "+" : ""}${Math.round(d.flowScore)}`);
    svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b);
    rows.append("rect").attr("class", "hit").attr("x", 0).attr("y", 0).attr("width", W).attr("height", rowH)
      .on("mousemove", (e, d) => showTip(e, instTip(d))).on("mouseleave", hideTip);
  }

  /* ---------- tabla de grupo ---------- */
  function groupTable(data) {
    const rows = data.map((d) => `<tr>
      <td>${esc(d.name)} <span class="muted">${esc(d.symbol)}</span></td>
      <td class="r num">${fmtPrice(d.price)}</td>
      <td class="r num ${cls(d.chg1d)}">${fmtPct(d.chg1d)}</td>
      <td class="r num ${cls(d.chg5d)}">${fmtPct(d.chg5d)}</td>
      <td class="r num ${cls(d.chg1m)}">${fmtPct(d.chg1m)}</td>
      <td class="r num">${d.avgDollarVolume20 > 0 ? d.relVolume.toFixed(2) + "×" : "—"}</td>
      <td class="r num ${cls(d.netFlow5d)}">${d.avgDollarVolume20 > 0 ? fmtUsd(d.netFlow5d) : "—"}</td>
      <td class="r num"><b>${d.flowScore > 0 ? "+" : ""}${d.flowScore.toFixed(1)}</b></td>
      <td><span class="pill ${cls(d.flowScore >= 15 ? 1 : d.flowScore <= -15 ? -1 : 0)}">${d.signal}</span></td></tr>`).join("");
    return `<table><thead><tr><th>Instrumento</th><th class="r">Precio</th><th class="r">1d</th><th class="r">5d</th><th class="r">1m</th>
      <th class="r">Vol. rel.</th><th class="r">Flujo 5d</th><th class="r">Puntuación</th><th>Señal</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderGroups() {
    const labels = { asset: "Clases de activo", region: "Países", sector: "Sectores EE.UU.", crypto: "Cripto" };
    $("#groupTabs").innerHTML = Object.entries(labels)
      .map(([k, v]) => `<button role="tab" data-g="${k}" aria-selected="${k === currentGroup}">${v}</button>`).join("");
    const data = snap.groups[currentGroup] ?? [];
    $("#groupChart").hidden = showTable;
    $("#groupTable").hidden = !showTable;
    $("#tableToggle").textContent = showTable ? "Ver gráfico" : "Ver tabla";
    if (showTable) $("#groupTable").innerHTML = groupTable(data);
    else barChart("#groupChart", data);
  }
  $("#groupTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-g]");
    if (!b) return;
    currentGroup = b.dataset.g;
    renderGroups();
  });
  $("#tableToggle").addEventListener("click", () => { showTable = !showTable; renderGroups(); });

  /* ---------- mapa ---------- */
  const ISO_NUM = { USA: "840", CAN: "124", MEX: "484", BRA: "076", CHL: "152", ARG: "032", COL: "170", PER: "604", GBR: "826", DEU: "276",
    FRA: "250", ITA: "380", ESP: "724", CHE: "756", JPN: "392", CHN: "156", HKG: "344", TWN: "158", KOR: "410", IND: "356", AUS: "036",
    SGP: "702", IDN: "360", THA: "764", VNM: "704", SAU: "682", TUR: "792", ZAF: "710", ISR: "376", POL: "616" };
  let world = null;
  async function renderMap() {
    const node = $("#map");
    try {
      world ??= await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json");
    } catch {
      node.innerHTML = '<p class="muted">No se pudo cargar el mapa.</p>';
      return;
    }
    const byNum = new Map(snap.groups.region.map((d) => [ISO_NUM[d.country], d]));
    const countries = topojson.feature(world, world.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
    const W = node.clientWidth || 900, H = Math.round(W * 0.48);
    const proj = d3.geoNaturalEarth1().fitSize([W, H], { type: "FeatureCollection", features: countries });
    const path = d3.geoPath(proj);
    node.innerHTML = "";
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Mapa de flujos por país");
    svg.selectAll("path").data(countries).join("path")
      .attr("d", path)
      .attr("class", (f) => `country ${byNum.has(f.id) ? "data" : "nodata"}`)
      .attr("fill", (f) => (byNum.has(f.id) ? divergingColor(byNum.get(f.id).flowScore) : null))
      .on("mousemove", (e, f) => { const d = byNum.get(f.id); if (d) showTip(e, instTip(d)); })
      .on("mouseleave", hideTip);
    // Marcadores para mercados demasiado pequeños para verse a esta escala.
    const small = [["HKG", [114.17, 22.3]], ["SGP", [103.82, 1.35]], ["ISR", [34.85, 31.05]], ["TWN", [121, 23.7]]];
    for (const [iso, ll] of small) {
      const d = snap.groups.region.find((x) => x.country === iso);
      if (!d) continue;
      const [cx, cy] = proj(ll);
      svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 5).attr("fill", divergingColor(d.flowScore))
        .attr("stroke", css("--text")).attr("stroke-width", 1)
        .on("mousemove", (e) => showTip(e, instTip(d))).on("mouseleave", hideTip);
    }
  }

  /* ---------- líneas ---------- */
  function lineChart(sel, points, { fmt = (v) => v.toFixed(0), yLabel = "", tipFmt = fmt, refZero = false, empty = "Sin datos todavía." } = {}) {
    const node = $(sel);
    node.innerHTML = "";
    if (!points?.length) return (node.innerHTML = `<p class="muted">${empty}</p>`);
    const W = node.clientWidth || 600, H = 220, m = { t: 10, r: 12, b: 24, l: 48 };
    const x = d3.scaleTime().domain(d3.extent(points, (p) => p.d)).range([m.l, W - m.r]);
    const ext = d3.extent(points, (p) => p.v);
    if (refZero) { ext[0] = Math.min(ext[0], -10); ext[1] = Math.max(ext[1], 10); }
    const y = d3.scaleLinear().domain(ext).nice().range([H - m.b, m.t]);
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", yLabel);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(fmt)).call((g) => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(W < 500 ? 4 : 6).tickSizeOuter(0));
    if (refZero) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    svg.append("path").datum(points).attr("class", "area")
      .attr("d", d3.area().x((p) => x(p.d)).y0(y(y.domain()[0])).y1((p) => y(p.v)).curve(d3.curveMonotoneX));
    svg.append("path").datum(points).attr("class", "series")
      .attr("d", d3.line().x((p) => x(p.d)).y((p) => y(p.v)).curve(d3.curveMonotoneX));
    const last = points.at(-1);
    svg.append("circle").attr("class", "focus-dot").attr("r", 4).attr("cx", x(last.d)).attr("cy", y(last.v));
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
    const dot = svg.append("circle").attr("class", "focus-dot").attr("r", 5).style("display", "none");
    const bis = d3.bisector((p) => p.d).center;
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const [mx] = d3.pointer(e);
        const p = points[bis(points, x.invert(mx))];
        cross.style("display", null).attr("x1", x(p.d)).attr("x2", x(p.d));
        dot.style("display", null).attr("cx", x(p.d)).attr("cy", y(p.v));
        showTip(e, `<div class="t">${p.d.toLocaleString("es", { dateStyle: "medium", ...(p.time ? { timeStyle: "short" } : {}) })}</div>${kv(yLabel, tipFmt(p.v))}`);
      })
      .on("mouseleave", () => { cross.style("display", "none"); dot.style("display", "none"); hideTip(); });
  }

  function renderLines() {
    const fed = snap.liquidity.fed?.series?.slice(-156).map((p) => ({ d: new Date(p.date), v: p.value / 1000 }));
    lineChart("#fedChart", fed, { fmt: (v) => `$${v.toFixed(1)}`, tipFmt: (v) => `$${v.toFixed(3)} bill.`, yLabel: "Liquidez neta" });
    const st = snap.liquidity.stablecoins?.series?.map((p) => ({ d: new Date(p.date), v: p.value / 1e9 }));
    lineChart("#stableChart", st, { fmt: (v) => `$${v.toFixed(0)}`, tipFmt: (v) => `$${v.toFixed(1)} mil M`, yLabel: "Stablecoins" });
    const rh = history.map((h) => ({ d: new Date(h.t), v: h.regime, time: true }));
    lineChart("#regimeChart", rh.length > 1 ? rh : null, { fmt: (v) => v.toFixed(0), tipFmt: (v) => v.toFixed(1), yLabel: "Régimen", refZero: true,
      empty: "El historial se acumula con cada actualización automática (cada ~10 min)." });
  }

  function renderMacro() {
    const rows = (snap.groups.macro ?? []).map((d) => `<tr><td>${esc(d.name)}</td><td class="r num">${fmtPrice(d.price)}</td>
      <td class="r num ${cls(d.chg1d)}">${fmtPct(d.chg1d)}</td><td class="r num ${cls(d.chg1m)}">${fmtPct(d.chg1m)}</td></tr>`).join("");
    $("#macro").innerHTML = `<table><thead><tr><th>Indicador</th><th class="r">Último</th><th class="r">1d</th><th class="r">1m</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderNarrative() {
    $("#narrative").innerHTML = snap.narrative.map((s) => `<li>${esc(s)}</li>`).join("");
  }

  function renderAll() {
    if (!snap) return;
    renderTiles();
    renderNarrative();
    barChart("#inflows", snap.topInflows);
    barChart("#outflows", snap.topOutflows);
    renderGroups();
    renderMap();
    renderLines();
    renderMacro();
    const t = new Date(snap.generatedAt);
    const mins = Math.round((Date.now() - t) / 60000);
    $("#updated").textContent = `Mercados: ${t.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })} (hace ${mins} min)`;
  }

  async function loadSnapshot() {
    try {
      const res = await fetch(`${SNAPSHOT_URL}?ts=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      snap = await res.json();
      try {
        const h = await fetch(`${HISTORY_URL}?ts=${Date.now()}`, { cache: "no-store" });
        if (h.ok) history = await h.json();
      } catch {}
      renderAll();
    } catch (e) {
      if (!snap) $("#narrative").innerHTML = `<li class="muted">No se pudo cargar el snapshot (${esc(e.message)}). Reintentando…</li>`;
    }
  }

  /* ---------- en vivo: CoinGecko global ---------- */
  async function liveCryptoGlobal() {
    try {
      const d = (await (await fetch("https://api.coingecko.com/api/v3/global")).json()).data;
      if (!snap?.liquidity) return;
      snap.liquidity.crypto = {
        ...snap.liquidity.crypto,
        totalMarketCapUsd: d.total_market_cap.usd,
        totalVolumeUsd: d.total_volume.usd,
        marketCapChange24hPct: d.market_cap_change_percentage_24h_usd,
        btcDominance: d.market_cap_percentage.btc,
      };
      renderTiles();
    } catch {}
  }

  /* ---------- en vivo: Coinbase WebSocket ---------- */
  const PAIRS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LINK-USD", "AVAX-USD", "LTC-USD"];
  const tick = {};
  function renderTicker() {
    $("#ticker").innerHTML = PAIRS.filter((p) => tick[p]).map((p) => {
      const t = tick[p];
      const ch = t.open ? ((t.price - t.open) / t.open) * 100 : 0;
      return `<span class="tk"><b>${p.replace("-USD", "")}</b><span class="num ${t.flash || ""}">$${fmtPrice(t.price)}</span><span class="num ${cls(ch)}">${fmtPct(ch)}</span></span>`;
    }).join("") || '<span class="muted">Conectando a precios en vivo…</span>';
  }
  let wsRetry = 1000;
  function connectWs() {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    ws.onopen = () => {
      wsRetry = 1000;
      ws.send(JSON.stringify({ type: "subscribe", product_ids: PAIRS, channels: ["ticker"] }));
      $("#liveDot").classList.add("on");
      $("#liveText").textContent = "En vivo";
    };
    let pending = false;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type !== "ticker") return;
      const prev = tick[d.product_id]?.price;
      const price = Number(d.price);
      tick[d.product_id] = { price, open: Number(d.open_24h), flash: prev == null ? "" : price > prev ? "flash-up" : price < prev ? "flash-down" : tick[d.product_id].flash };
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderTicker(); }); }
    };
    ws.onclose = () => {
      $("#liveDot").classList.remove("on");
      $("#liveText").textContent = "Reconectando…";
      setTimeout(connectWs, (wsRetry = Math.min(wsRetry * 2, 30000)));
    };
    ws.onerror = () => ws.close();
  }

  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 200); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);

  renderTicker();
  loadSnapshot().then(liveCryptoGlobal);
  connectWs();
  setInterval(loadSnapshot, REFRESH_MS);
  setInterval(liveCryptoGlobal, REFRESH_MS);
})();
