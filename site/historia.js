/* Volumen — Historial de flujos de liquidez (datos en data/history/*.json, regenerados a diario). */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const tip = $("#tip");
  const params = new URLSearchParams(location.search);

  const GROUPS = { asset: "Clases de activo", region: "Países", sector: "Sectores EE.UU.", crypto: "Cripto" };
  const RES = { monthly: "Mensual", weekly: "Semanal" };
  const RANGES = { 1: "1 año", 3: "3 años", 5: "5 años", 10: "10 años", 0: "Máx." };
  const CUM = { usd: "USD acumulado", int: "Intensidad acumulada" };

  const state = {
    group: GROUPS[params.get("g")] ? params.get("g") : "sector",
    res: params.get("r") === "weekly" ? "weekly" : "monthly",
    range: RANGES[params.get("p")] ? Number(params.get("p")) : 10,
    cum: "usd",
    selected: [], // [{symbol, slot}]
  };
  const cache = {};
  let macro = null, regime = null, view = null;

  /* ---------- tema ---------- */
  try { const t = localStorage.getItem("volumen-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("#themeBtn").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("volumen-theme", dark ? "light" : "dark"); } catch {}
    render();
  });
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const isDark = () => getComputedStyle(document.documentElement).colorScheme.includes("dark");
  // Paleta categórica validada (slots 1-4, orden fijo; el color sigue a la entidad seleccionada).
  const SERIES = { light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], dark: ["#3987e5", "#d95926", "#199e70", "#c98500"] };
  const slotColor = (slot) => SERIES[isDark() ? "dark" : "light"][slot];

  /* ---------- formato ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmtM = (m) => { // millones USD → texto
    if (m == null || !isFinite(m)) return "—";
    const a = Math.abs(m), s = m < 0 ? "−" : "";
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)} bill.`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)} mil M`;
    return `${s}$${a.toFixed(0)} M`;
  };
  const fmtPct = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}%`);
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const fmtPeriod = (p) => (p.length === 7 ? `${MESES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}` : `sem. ${+p.slice(8, 10)} ${MESES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`);
  const toDate = (p) => new Date(p.length === 7 ? `${p}-15` : p);
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;

  function showTip(evt, html) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => (tip.hidden = true);

  function divColor(v) {
    if (v == null) return null;
    const t = Math.max(-1, Math.min(1, v / 40));
    return t >= 0 ? d3.interpolateRgb(css("--mid"), css("--in"))(t) : d3.interpolateRgb(css("--mid"), css("--out"))(-t);
  }

  /* ---------- controles ---------- */
  function seg(el, options, current, onPick) {
    el.innerHTML = (Array.isArray(options) ? options : Object.entries(options)).map(([k, v]) => `<button role="tab" data-k="${k}" aria-selected="${String(k) === String(current)}">${v}</button>`).join("");
    el.onclick = (e) => { const b = e.target.closest("button[data-k]"); if (b) onPick(b.dataset.k); };
  }
  function renderControls() {
    seg($("#groupSeg"), GROUPS, state.group, (k) => { state.group = k; state.selected = []; load(); });
    seg($("#resSeg"), RES, state.res, (k) => { state.res = k; load(); });
    seg($("#rangeSeg"), [1, 3, 5, 10, 0].map((k) => [k, RANGES[k]]), state.range, (k) => { state.range = Number(k); state.selected = []; compute(); render(); });
    seg($("#cumSeg"), CUM, state.cum, (k) => { state.cum = k; renderCum(); renderControls(); });
    const u = new URL(location.href);
    u.searchParams.set("g", state.group); u.searchParams.set("r", state.res); u.searchParams.set("p", state.range);
    history.replaceState(null, "", u);
  }

  /* ---------- datos ---------- */
  async function getJson(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }
  async function load() {
    renderControls();
    const key = `${state.group}-${state.res}`;
    try {
      cache[key] ??= await getJson(`data/history/${key}.json`);
      compute();
      render();
    } catch (e) {
      $("#heat").innerHTML = `<p class="muted">No se pudo cargar el historial (${esc(e.message)}).</p>`;
    }
  }

  /** Recorta al periodo elegido y calcula agregados por instrumento. */
  function compute() {
    const data = cache[`${state.group}-${state.res}`];
    if (!data) return;
    let from = 0;
    if (state.range) {
      const cut = new Date();
      cut.setFullYear(cut.getFullYear() - state.range);
      const c = cut.toISOString().slice(0, data.periods[0].length);
      from = data.periods.findIndex((p) => p >= c);
      if (from < 0) from = 0;
    }
    const periods = data.periods.slice(from);
    const rows = data.series.map((s) => {
      const nf = s.nf.slice(from), dv = s.dv.slice(from), ret = s.ret.slice(from);
      const inten = nf.map((x, i) => (x == null || !dv[i] ? null : (x / dv[i]) * 100));
      let sNf = 0, sDv = 0, growth = 1, pos = 0, n = 0;
      nf.forEach((x, i) => { if (x != null && dv[i]) { sNf += x; sDv += dv[i]; n++; if (x > 0) pos++; } });
      ret.forEach((r) => { if (r != null) growth *= 1 + r / 100; });
      return { ...s, nfR: nf, dvR: dv, retR: ret, inten, totalNf: sNf, avgInt: sDv ? (sNf / sDv) * 100 : null, cumRet: (growth - 1) * 100, posPct: n ? (pos / n) * 100 : null, n };
    }).filter((r) => r.n > 0).sort((a, b) => (b.avgInt ?? -999) - (a.avgInt ?? -999));
    view = { periods, rows, label: data.label };
    if (!state.selected.length) {
      const pick = rows.length <= 4 ? rows : [...rows.slice(0, 2), ...rows.slice(-2)];
      state.selected = pick.map((r, i) => ({ symbol: r.symbol, slot: i }));
    }
  }

  function toggle(symbol) {
    const i = state.selected.findIndex((s) => s.symbol === symbol);
    if (i >= 0) state.selected.splice(i, 1);
    else {
      if (state.selected.length >= 4) state.selected.shift(); // máximo 4 series legibles
      const used = new Set(state.selected.map((s) => s.slot));
      state.selected.push({ symbol, slot: [0, 1, 2, 3].find((k) => !used.has(k)) });
    }
    renderCum(); renderRank(); renderHeat();
  }

  /* ---------- mapa de calor (canvas) ---------- */
  function renderHeat() {
    const box = $("#heat");
    if (!box.querySelector("canvas")) box.innerHTML = '<canvas id="heatCanvas"></canvas>';
    const cv = box.querySelector("canvas");
    const { periods, rows } = view;
    const W = box.clientWidth || 900;
    const labelW = Math.min(170, W * 0.34), top = 22, rowH = 18;
    const H = top + rows.length * rowH + 4;
    const dpr = devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const cw = (W - labelW) / periods.length;
    const sel = new Map(state.selected.map((s) => [s.symbol, s.slot]));
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const empty = css("--surface-2");
    rows.forEach((r, ri) => {
      const y = top + ri * rowH;
      ctx.fillStyle = sel.has(r.symbol) ? css("--text") : css("--text-2");
      ctx.textAlign = "right";
      let name = r.name;
      while (name.length > 4 && ctx.measureText(name).width > labelW - 22) name = name.slice(0, -2).trimEnd() + "…";
      ctx.fillText(name, labelW - (sel.has(r.symbol) ? 18 : 8), y + rowH / 2);
      if (sel.has(r.symbol)) {
        ctx.fillStyle = slotColor(sel.get(r.symbol));
        ctx.beginPath(); ctx.arc(labelW - 9, y + rowH / 2, 4, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = 0; i < periods.length; i++) {
        const v = r.inten[i];
        ctx.fillStyle = v == null ? empty : divColor(v);
        // 1px de separación (superficie) entre celdas cuando caben.
        const gap = cw > 4 ? 1 : 0;
        ctx.fillRect(labelW + i * cw, y + 1, Math.max(cw - gap, 0.6), rowH - 2);
      }
    });
    // eje temporal: años
    ctx.fillStyle = css("--muted");
    ctx.textAlign = "center";
    ctx.font = "11px Inter, system-ui, sans-serif";
    const years = [...new Set(periods.map((p) => p.slice(0, 4)))];
    const step = Math.ceil(years.length / Math.max(2, Math.floor((W - labelW) / 60)));
    years.forEach((y, k) => {
      if (k % step) return;
      const i = periods.findIndex((p) => p.startsWith(y));
      ctx.fillText(y, labelW + i * cw + Math.max(cw * 6, 12), 10);
    });

    cv.onmousemove = (e) => {
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const ri = Math.floor((y - top) / rowH), ci = Math.floor((x - labelW) / cw);
      const r = rows[ri];
      if (!r || ci < 0 || ci >= periods.length || x < labelW) {
        if (r && x < labelW) { cv.style.cursor = "pointer"; return hideTip(); }
        cv.style.cursor = "default"; return hideTip();
      }
      cv.style.cursor = "pointer";
      const v = r.inten[ci];
      showTip(e, `<div class="t">${esc(r.name)} <span class="muted">${esc(r.symbol)}</span></div>
        <div class="muted" style="margin-bottom:4px">${fmtPeriod(periods[ci])}</div>` +
        (v == null ? '<div class="muted">Sin datos en este periodo</div>' :
          kv("Intensidad", `${v > 0 ? "+" : ""}${v.toFixed(1)}`) + kv("Flujo neto", fmtM(r.nfR[ci])) +
          kv("Volumen", fmtM(r.dvR[ci])) + kv("Rendimiento", fmtPct(r.retR[ci]))));
    };
    cv.onmouseleave = hideTip;
    cv.onclick = (e) => {
      const rect = cv.getBoundingClientRect();
      const r = rows[Math.floor((e.clientY - rect.top - top) / rowH)];
      if (r) toggle(r.symbol);
    };
  }

  /* ---------- flujo acumulado ---------- */
  let cumKeys = null;
  addEventListener("keydown", (e) => cumKeys?.(e));
  function renderCum() {
    const node = $("#cumChart");
    const { periods, rows } = view;
    const sel = state.selected.map((s) => ({ ...s, row: rows.find((r) => r.symbol === s.symbol) })).filter((s) => s.row);
    $("#chips").innerHTML = sel.length
      ? sel.map((s) => `<button class="chip" data-s="${esc(s.symbol)}" title="Quitar"><i style="background:${slotColor(s.slot)}"></i>${esc(s.row.name)} <span class="x">×</span></button>`).join("") +
        '<span class="hint" style="align-self:center">Clic en el mapa de calor o en el ranking para añadir (máx. 4)</span>'
      : '<span class="hint">Selecciona instrumentos en el mapa de calor o en el ranking.</span>';
    $("#chips").onclick = (e) => { const b = e.target.closest(".chip"); if (b) toggle(b.dataset.s); };
    node.innerHTML = "";
    if (!sel.length) return;

    const series = sel.map((s) => {
      let cNf = 0, cDv = 0;
      const pts = [];
      periods.forEach((p, i) => {
        const nf = s.row.nfR[i], dv = s.row.dvR[i];
        if (nf == null || !dv) return;
        cNf += nf; cDv += dv;
        pts.push({ d: toDate(p), p, v: state.cum === "usd" ? cNf / 1000 : (cNf / cDv) * 100 });
      });
      return { ...s, pts };
    }).filter((s) => s.pts.length);

    const W = node.clientWidth || 800, H = 300, m = { t: 12, r: 120, b: 26, l: 62 };
    if (W < 560) m.r = 12;
    const x = d3.scaleTime().domain(d3.extent(periods, toDate)).range([m.l, W - m.r]);
    const all = series.flatMap((s) => s.pts.map((p) => p.v));
    const y = d3.scaleLinear().domain(d3.extent([0, ...all])).nice().range([H - m.b, m.t]);
    const fmtY = state.cum === "usd" ? (v) => `$${d3.format(",.0f")(v)}` : (v) => v.toFixed(0);
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Flujo acumulado");
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.l - m.r)).tickFormat(fmtY)).call((g) => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W < 600 ? 4 : 8).tickSizeOuter(0));
    svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    const line = d3.line().x((p) => x(p.d)).y((p) => y(p.v));
    for (const s of series) {
      svg.append("path").datum(s.pts).attr("fill", "none").attr("stroke", slotColor(s.slot)).attr("stroke-width", 2).attr("d", line);
    }
    // etiquetas directas al final de cada línea (sin solaparse)
    if (W >= 560) {
      const ends = series.map((s) => ({ s, y: y(s.pts.at(-1).v) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
      for (const e of ends) {
        svg.append("text").attr("x", W - m.r + 8).attr("y", e.y).attr("dy", "0.35em").style("fill", css("--text-2")).style("font-size", "12px")
          .text(e.s.row.name.length > 16 ? e.s.row.name.slice(0, 15) + "…" : e.s.row.name);
      }
    }
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
    const dots = series.map((s) => svg.append("circle").attr("r", 4).attr("fill", slotColor(s.slot)).attr("stroke", css("--surface")).attr("stroke-width", 2).style("display", "none"));
    const bis = d3.bisector((p) => p.d).center;
    // La zona activa cubre todo el ancho (incluidas las etiquetas): más allá del último dato se fija en el último periodo.
    const pDates = periods.map(toDate);
    let cur = -1, lastEvt = null;
    const showAt = (idx, e) => {
      cur = Math.max(0, Math.min(pDates.length - 1, idx));
      const d = pDates[cur];
      let html = "", px = null;
      series.forEach((s, k) => {
        const p = s.pts[bis(s.pts, d)];
        if (!p) return;
        px ??= p;
        dots[k].style("display", null).attr("cx", x(p.d)).attr("cy", y(p.v));
        html += `<div class="kv"><span><i class="swatch" style="background:${slotColor(s.slot)}"></i>${esc(s.row.name)}</span><b>${state.cum === "usd" ? fmtM(p.v * 1000) : p.v.toFixed(1)}</b></div>`;
      });
      if (!px) return;
      cross.style("display", null).attr("x1", x(px.d)).attr("x2", x(px.d));
      showTip(e, `<div class="t">${fmtPeriod(px.p)}</div>${html}<div class="muted small" style="margin-top:4px">← → para moverte por periodo</div>`);
    };
    // La zona activa cubre todo el ancho (incluidas las etiquetas): más allá del último dato se fija en el último periodo.
    svg.append("rect").attr("x", 0).attr("y", m.t).attr("width", W).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        lastEvt = e;
        const d = x.invert(Math.max(m.l, Math.min(W - m.r, d3.pointer(e)[0])));
        showAt(d3.bisector((t) => t).center(pDates, d), e);
      })
      .on("mouseleave", () => { lastEvt = null; cross.style("display", "none"); dots.forEach((d) => d.style("display", "none")); hideTip(); });
    cumKeys = (e) => {
      if (!lastEvt || cur < 0 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      showAt(cur + (e.key === "ArrowRight" ? 1 : -1), lastEvt);
    };
    svg.append("text").attr("x", m.l).attr("y", 8).style("fill", css("--muted")).style("font-size", "11px")
      .text(state.cum === "usd" ? "Miles de millones USD" : "Flujo acumulado ÷ volumen acumulado × 100");
  }

  /* ---------- ranking ---------- */
  function renderRank() {
    const { periods, rows } = view;
    $("#rankHint").textContent = `${fmtPeriod(periods[0])} → ${fmtPeriod(periods.at(-1))}`;
    const sel = new Map(state.selected.map((s) => [s.symbol, s.slot]));
    $("#rank").innerHTML = `<table><thead><tr><th>Instrumento</th><th>Datos desde</th><th class="r">Flujo neto</th><th class="r">Intensidad media</th>
      <th class="r">Rendimiento</th><th class="r">% periodos con entrada</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="clickable${sel.has(r.symbol) ? " sel" : ""}" data-s="${esc(r.symbol)}">
        <td>${sel.has(r.symbol) ? `<i class="swatch" style="background:${slotColor(sel.get(r.symbol))}"></i>` : '<i class="swatch" style="background:transparent"></i>'}${esc(r.name)} <span class="muted">${esc(r.symbol)}</span></td>
        <td class="num muted">${r.start ?? "—"}</td>
        <td class="r num ${cls(r.totalNf)}">${fmtM(r.totalNf)}</td>
        <td class="r num ${cls(r.avgInt)}"><b>${r.avgInt == null ? "—" : (r.avgInt > 0 ? "+" : "") + r.avgInt.toFixed(1)}</b></td>
        <td class="r num ${cls(r.cumRet)}">${fmtPct(r.cumRet)}</td>
        <td class="r num">${r.posPct == null ? "—" : r.posPct.toFixed(0) + "%"}</td></tr>`).join("") + "</tbody></table>";
    $("#rank").onclick = (e) => { const tr = e.target.closest("tr[data-s]"); if (tr) toggle(tr.dataset.s); };
  }

  /* ---------- régimen histórico ---------- */
  function rangeStart() {
    if (!state.range) return null;
    const d = new Date(); d.setFullYear(d.getFullYear() - state.range); return d;
  }
  function renderRegime() {
    const node = $("#regimeChart");
    node.innerHTML = "";
    if (!regime) return;
    const start = rangeStart();
    const pts = regime.periods.map((p, i) => ({ p, d: toDate(p), v: regime.values[i] })).filter((x) => x.v != null && (!start || x.d >= start));
    if (!pts.length) return (node.innerHTML = '<p class="muted">Sin datos.</p>');
    const W = node.clientWidth || 800, H = 220, m = { t: 10, r: 12, b: 24, l: 40 };
    const x = d3.scaleBand().domain(pts.map((p) => p.p)).range([m.l, W - m.r]).paddingInner(pts.length > 120 ? 0 : 0.15);
    const ext = d3.max(pts, (p) => Math.abs(p.v));
    const y = d3.scaleLinear().domain([-ext, ext]).nice().range([H - m.b, m.t]);
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Régimen histórico");
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r))).call((g) => g.select(".domain").remove());
    const years = pts.filter((p, i) => p.p.endsWith("-01") || i === 0);
    const every = Math.ceil(years.length / Math.max(2, Math.floor(W / 70)));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(years.filter((_, i) => i % every === 0).map((p) => p.p)).tickFormat((p) => p.slice(0, 4)).tickSizeOuter(0));
    svg.append("g").selectAll("rect").data(pts).join("rect")
      .attr("x", (p) => x(p.p)).attr("width", Math.max(x.bandwidth(), 0.8))
      .attr("y", (p) => y(Math.max(0, p.v))).attr("height", (p) => Math.abs(y(p.v) - y(0)))
      .attr("fill", (p) => (p.v >= 0 ? css("--in") : css("--out")));
    svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    svg.append("rect").attr("x", 0).attr("y", m.t).attr("width", W).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const i = Math.max(0, Math.min(pts.length - 1, Math.floor((d3.pointer(e)[0] - m.l) / x.step())));
        const p = pts[i];
        showTip(e, `<div class="t">${fmtPeriod(p.p)}</div>${kv("Riesgo − refugio", `${p.v > 0 ? "+" : ""}${p.v.toFixed(1)}`)}<div class="muted small">${p.v > 0 ? "El dinero buscó riesgo" : "El dinero buscó refugio"}</div>`);
      })
      .on("mouseleave", hideTip);
  }

  /* ---------- macro (pequeños múltiplos, cada uno con su propio eje) ---------- */
  function miniLine(sel, points, { fmt, tipFmt, zero = false }) {
    const node = $(sel);
    node.innerHTML = "";
    const start = rangeStart();
    const pts = points.filter((p) => p.v != null && isFinite(p.v) && (!start || p.d >= start));
    if (pts.length < 2) return (node.innerHTML = '<p class="muted">Sin datos para este periodo.</p>');
    const W = node.clientWidth || 500, H = 170, m = { t: 8, r: 10, b: 22, l: 46 };
    const x = d3.scaleTime().domain([start ?? pts[0].d, pts.at(-1).d]).range([m.l, W - m.r]);
    const ext = d3.extent(pts, (p) => p.v);
    if (zero) { ext[0] = Math.min(ext[0], 0); ext[1] = Math.max(ext[1], 0); }
    const y = d3.scaleLinear().domain(ext).nice().range([H - m.b, m.t]);
    const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(fmt)).call((g) => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W < 450 ? 3 : 5).tickSizeOuter(0));
    if (zero) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    svg.append("path").datum(pts).attr("class", "series").attr("d", d3.line().x((p) => x(p.d)).y((p) => y(p.v)));
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
    const dot = svg.append("circle").attr("class", "focus-dot").attr("r", 4).style("display", "none");
    const bis = d3.bisector((p) => p.d).center;
    svg.append("rect").attr("x", 0).attr("y", m.t).attr("width", W).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const p = pts[bis(pts, x.invert(Math.max(m.l, Math.min(W - m.r, d3.pointer(e)[0]))))];
        cross.style("display", null).attr("x1", x(p.d)).attr("x2", x(p.d));
        dot.style("display", null).attr("cx", x(p.d)).attr("cy", y(p.v));
        showTip(e, `<div class="t">${p.d.toLocaleDateString("es", { timeZone: "UTC", year: "numeric", month: "short", day: p.day ? "numeric" : undefined })}</div>${kv("Valor", tipFmt(p.v))}`);
      })
      .on("mouseleave", () => { cross.style("display", "none"); dot.style("display", "none"); hideTip(); });
  }
  function renderMacro() {
    if (!macro) return;
    const P = (arr, f = (v) => v, day = true) => arr.map((p) => ({ d: new Date(p.date.length === 7 ? `${p.date}-15` : p.date), v: f(p.value), day }));
    miniLine("#mFed", P(macro.fedNetLiquidity, (v) => v / 1000), { fmt: (v) => `$${v.toFixed(1)}`, tipFmt: (v) => `$${v.toFixed(2)} bill.` });
    const m2 = macro.m2.map((p, i, a) => (i >= 12 ? { date: p.date, value: ((p.value - a[i - 12].value) / a[i - 12].value) * 100 } : null)).filter(Boolean);
    miniLine("#mM2", P(m2, (v) => v, false), { fmt: (v) => `${v.toFixed(0)}%`, tipFmt: (v) => fmtPct(v), zero: true });
    miniLine("#mStable", P(macro.stablecoins.filter((p) => p.value > 0)), { fmt: (v) => `$${v.toFixed(0)}`, tipFmt: (v) => `$${v.toFixed(1)} mil M` });
    miniLine("#mVix", P(macro.vix, (v) => v, false), { fmt: (v) => v.toFixed(0), tipFmt: (v) => v.toFixed(2) });
  }

  function render() {
    if (!view) return;
    renderControls();
    renderHeat();
    renderCum();
    renderRank();
    renderRegime();
    renderMacro();
  }

  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

  (async () => {
    await load();
    try {
      [macro, regime] = await Promise.all([getJson("data/history/macro.json"), getJson("data/history/regime.json")]);
      const meta = await getJson("data/history/meta.json");
      $("#updated").textContent = `Historial actualizado: ${new Date(meta.generatedAt).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })}`;
    } catch {}
    renderRegime();
    renderMacro();
  })();
})();
