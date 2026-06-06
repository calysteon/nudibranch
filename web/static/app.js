"use strict";

// Pacific Northwest fallback view, used before any data loads.
const PNW_CENTER = [47.9, -122.7];
const PNW_ZOOM = 8;

const map = L.map("map").setView(PNW_CENTER, PNW_ZOOM);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let markerLayer = L.layerGroup().addTo(map);

const regionSel = document.getElementById("region");
const dateInput = document.getElementById("date");
const form = document.getElementById("controls");
const list = document.getElementById("beach-list");
const summary = document.getElementById("summary");
const dataNote = document.getElementById("data-note");
const tideScrubber = document.getElementById("tide-scrubber");
const tideSlider = document.getElementById("tide-time");
const tideTimeLabel = document.getElementById("tide-time-label");
const tideNote = document.getElementById("tide-scrubber-note");
const tideSliderGroup = document.getElementById("tide-slider-group");
const hourEnable = document.getElementById("tide-hour-enable");

// View state. "slug" shows every sighting; "tide" shows only sightings at
// beaches with a daylight low tide that day - or, if the hour filter is on,
// only beaches whose tide is low at the scrubbed time.
let viewMode = "slug";
let currentPlan = null;
let hourFilter = false; // when true, narrow tide view to a single hour
let tideMinute = 720; // minutes since midnight for the tide scrubber
const LOW_TIDE_FT = 2.0; // a beach is "exposed" when its tide is at/below this

form.addEventListener("submit", (e) => {
  e.preventDefault();
  loadPlan();
});

document.querySelectorAll(".viewtoggle .vt").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.view === viewMode) return;
    viewMode = btn.dataset.view;
    document.querySelectorAll(".viewtoggle .vt").forEach((b) => b.classList.toggle("active", b === btn));
    tideScrubber.hidden = viewMode !== "tide";
    if (viewMode === "tide" && hourFilter) initTideMinute();
    if (currentPlan) renderMarkers(currentPlan);
  });
});

tideSlider.addEventListener("input", () => {
  tideMinute = parseInt(tideSlider.value, 10);
  updateTideLabel();
  if (currentPlan) renderMarkers(currentPlan);
});

hourEnable.addEventListener("change", () => {
  hourFilter = hourEnable.checked;
  tideSlider.disabled = !hourFilter;
  tideSliderGroup.classList.toggle("disabled", !hourFilter);
  if (hourFilter) initTideMinute();
  if (currentPlan) renderMarkers(currentPlan);
});

// tideHeightAt interpolates a beach's tide height (ft) at a given minute, using
// cosine interpolation between the day's high/low extremes.
function tideHeightAt(all, minute) {
  if (!all || all.length === 0) return null;
  if (minute <= all[0].minutes) return all[0].heightFt;
  const last = all[all.length - 1];
  if (minute >= last.minutes) return last.heightFt;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1];
    if (minute >= a.minutes && minute <= b.minutes) {
      const f = (minute - a.minutes) / (b.minutes - a.minutes);
      return (a.heightFt + b.heightFt) / 2 + ((a.heightFt - b.heightFt) / 2) * Math.cos(Math.PI * f);
    }
  }
  return last.heightFt;
}

function fmtMinute(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h < 12 ? "am" : "pm";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ap}`;
}

function updateTideLabel() {
  tideTimeLabel.textContent = fmtMinute(tideMinute);
}

// initTideMinute picks a sensible default scrubber time: the current time when
// viewing today, otherwise the moment of the region's lowest low tide.
function initTideMinute() {
  let m = 12 * 60;
  const t = new Date();
  const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  if (currentPlan && currentPlan.date === todayStr) {
    m = t.getHours() * 60 + t.getMinutes();
  } else if (currentPlan) {
    let best = null;
    for (const b of currentPlan.beaches) {
      for (const e of b.allTides || []) {
        if (e.kind === "L" && (best === null || e.heightFt < best.h)) best = { h: e.heightFt, min: e.minutes };
      }
    }
    if (best) m = best.min;
  }
  tideMinute = m;
  tideSlider.value = String(m);
  updateTideLabel();
}

function inatLink(s) {
  if (s.taxonId && s.taxonId > 0) {
    return `https://www.inaturalist.org/taxa/${s.taxonId}`;
  }
  return `https://www.inaturalist.org/observations?taxon_name=${encodeURIComponent(s.scientific)}`;
}

// slugImg builds the local thumbnail URL for a species from its scientific name
// ("Aeolidia loui" -> "static/slugs/aeolidia_loui.jpg"). The path is relative so
// the site works both at a domain root and on a GitHub Pages project subpath.
function slugImg(scientific) {
  return "static/slugs/" + scientific.toLowerCase().replace(/\s+/g, "_") + ".jpg";
}

// beachColor returns a stable identity color for a beach, derived from its id so
// the same beach always maps to the same hue across views.
function beachColor(b) {
  let h = 0;
  for (let i = 0; i < b.id.length; i++) h = (h * 31 + b.id.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 45%)`;
}

const SLUG_FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='%23e8e2d2'/><text x='24' y='32' font-size='26' text-anchor='middle'>🐌</text></svg>`
  );

function tideBadge(t) {
  const cls = t.minus ? "tide minus" : "tide";
  const ft = t.heightFt.toFixed(1);
  return `<span class="${cls}" title="${t.minus ? "Minus tide - excellent" : "Low tide"}">${t.time} · ${ft} ft</span>`;
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h < 12 ? "am" : "pm";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ap}`;
}

// tideChart renders an SVG tide curve for the day from the high/low extremes,
// using cosine interpolation between turning points (the standard smooth tide
// shape). The waking-hour window is shaded and low tides are highlighted.
function tideChart(all, plan) {
  if (!all || all.length < 2) return "";
  const W = 320, H = 112, padL = 6, padR = 6, padT = 16, padB = 18;
  const hts = all.map((e) => e.heightFt);
  let lo = Math.min(...hts), hi = Math.max(...hts);
  const span = Math.max(1, hi - lo);
  lo -= span * 0.18; hi += span * 0.18;
  const baseY = H - padB;
  const x = (min) => padL + (min / 1440) * (W - padL - padR);
  const y = (h) => padT + (1 - (h - lo) / (hi - lo)) * (H - padT - padB);

  const interp = (m) => {
    if (m <= all[0].minutes) return all[0].heightFt;
    const last = all[all.length - 1];
    if (m >= last.minutes) return last.heightFt;
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i], b = all[i + 1];
      if (m >= a.minutes && m <= b.minutes) {
        const f = (m - a.minutes) / (b.minutes - a.minutes);
        return (a.heightFt + b.heightFt) / 2 + ((a.heightFt - b.heightFt) / 2) * Math.cos(Math.PI * f);
      }
    }
    return last.heightFt;
  };

  const pts = [];
  for (let m = 0; m <= 1440; m += 8) pts.push([x(m), y(interp(m))]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const fill = `M${x(0).toFixed(1)} ${baseY} ` +
    pts.map((p) => "L" + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ") +
    ` L${x(1440).toFixed(1)} ${baseY} Z`;

  const dx = x(plan.wakeStart * 60), dw = x(plan.wakeEnd * 60) - dx;
  const dayRect = `<rect class="tc-day" x="${dx.toFixed(1)}" y="${padT}" width="${dw.toFixed(1)}" height="${(H - padT - padB).toFixed(1)}"/>`;

  let zero = "";
  if (lo < 0 && hi > 0) {
    const zy = y(0).toFixed(1);
    zero = `<line class="tc-zero" x1="${padL}" y1="${zy}" x2="${W - padR}" y2="${zy}"/>`;
  }

  let now = "";
  const t = new Date();
  const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  if (plan.date === todayStr) {
    const nx = x(t.getHours() * 60 + t.getMinutes()).toFixed(1);
    now = `<line class="tc-now" x1="${nx}" y1="${padT}" x2="${nx}" y2="${baseY}"/>`;
  }

  let dots = "";
  for (const e of all) {
    const cx = x(e.minutes), cy = y(e.heightFt);
    const isLow = e.kind === "L";
    const cls = isLow ? (e.minus ? "low minus" : "low") : "";
    let anchor = "middle";
    if (cx < 24) anchor = "start"; else if (cx > W - 24) anchor = "end";
    dots += `<circle class="tc-dot ${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3"/>`;
    if (isLow) {
      dots += `<text class="tc-label" x="${cx.toFixed(1)}" y="${(cy + 12).toFixed(1)}" text-anchor="${anchor}">${fmtTime(e.time)} · ${e.heightFt.toFixed(1)}'</text>`;
    } else {
      dots += `<text class="tc-label" x="${cx.toFixed(1)}" y="${(cy - 5).toFixed(1)}" text-anchor="${anchor}">${e.heightFt.toFixed(1)}'</text>`;
    }
  }

  return `<div class="tide-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tide curve for the day">` +
    `${dayRect}${zero}<path class="tc-fill" d="${fill}"/><path class="tc-line" d="${line}"/>${now}${dots}</svg></div>`;
}

// tideTable lists every high/low for the day with its clock time and height.
function tideTable(all) {
  if (!all || all.length === 0) return "";
  const rows = all.map((e) => {
    const isLow = e.kind === "L";
    const trCls = e.minus ? "is-minus" : isLow ? "is-low" : "";
    const kCls = "kind" + (e.minus ? " minus" : isLow ? " low" : "");
    return `<tr class="${trCls}"><td class="${kCls}">${isLow ? "Low" : "High"}</td>` +
      `<td>${fmtTime(e.time)}</td><td class="ht">${e.heightFt.toFixed(1)} ft</td></tr>`;
  }).join("");
  return `<table class="tide-table">${rows}</table>`;
}

function speciesList(species) {
  if (!species || species.length === 0) {
    return `<p class="none">No recorded sightings here this month.</p>`;
  }
  const items = species
    .map(
      (s) =>
        `<li class="sp">
           <a class="sp-photo" href="${inatLink(s)}" target="_blank" rel="noopener" title="${s.commonName} - view on iNaturalist">
             <img src="${slugImg(s.scientific)}" alt="${s.commonName}" loading="lazy"
                  onerror="this.onerror=null;this.src='${SLUG_FALLBACK}'">
           </a>
           <div class="sp-text">
             <a class="sp-name" href="${inatLink(s)}" target="_blank" rel="noopener">${s.commonName}</a>
             <span class="sp-sci">${s.scientific}</span>
           </div>
           <span class="sp-count" title="${s.count} research-grade sightings this month">${s.count}</span>
         </li>`
    )
    .join("");
  return `<ul class="species">${items}</ul>`;
}

function renderBeachCard(b, plan) {
  const li = document.createElement("li");
  li.className = "beach" + (b.hasLowTide ? "" : " no-tide");
  li.id = "beach-" + b.id;
  let inner =
    `<h3 class="beach-title" title="Show sightings on the map"><span class="swatch" style="background:${beachColor(b)}"></span>${b.name}` +
    `<span class="zoom-hint">⤢</span></h3><p class="blurb">${b.blurb}</p>`;

  if (b.tideError) {
    inner += `<p class="err">Tide data unavailable: ${b.tideError}</p>`;
  } else {
    if (b.hasLowTide) {
      inner += `<div class="tides">${b.lowTides.map(tideBadge).join("")}</div>`;
    } else {
      inner += `<p class="none">No daylight low tide on this date.</p>`;
    }
    inner += tideChart(b.allTides, plan);
    inner += tideTable(b.allTides);
    if (b.hasLowTide) inner += speciesList(b.species);
  }
  li.innerHTML = inner;
  // Clicking a beach's title flies the map to that beach's sightings.
  li.querySelector(".beach-title").addEventListener("click", () => zoomToBeach(b));
  return li;
}

function scrollToBeach(b) {
  const card = document.getElementById("beach-" + b.id);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
}

// zoomToBeach flies the map to the spread of a beach's species sightings.
function zoomToBeach(b) {
  const pts = (b.species || [])
    .filter((s) => s.lat && s.lon)
    .map((s) => [s.lat, s.lon]);
  if (pts.length <= 1) {
    map.flyTo([b.lat, b.lon], 14, { duration: 0.6 });
  } else {
    map.flyToBounds(pts, { padding: [70, 70], maxZoom: 15, duration: 0.6 });
  }
}

function render(plan) {
  currentPlan = plan;
  list.innerHTML = "";

  const withTide = plan.beaches.filter((b) => b.hasLowTide).length;
  summary.textContent = `${plan.date}: ${withTide} of ${plan.beaches.length} beaches have a daylight low tide.`;
  dataNote.textContent = "Species data: " + plan.speciesDataAt;

  for (const b of plan.beaches) {
    list.appendChild(renderBeachCard(b, plan));
  }

  if (viewMode === "tide" && hourFilter) initTideMinute();
  renderMarkers(plan);

  const bounds = plan.beaches.map((b) => [b.lat, b.lon]);
  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
  }
}

// renderMarkers redraws the map for the active view. In slug view every beach's
// sightings show; in tide view only beaches whose tide is low at the scrubbed
// time keep their sightings - the rest fade to a faint dot.
function renderMarkers(plan) {
  markerLayer.clearLayers();
  if (viewMode === "tide") {
    let exposed = 0;
    for (const b of plan.beaches) {
      const color = beachColor(b);
      let isLow;
      if (hourFilter) {
        const h = tideHeightAt(b.allTides, tideMinute);
        isLow = h !== null && h <= LOW_TIDE_FT;
      } else {
        // Whole day: any beach with a daylight low tide today.
        isLow = b.hasLowTide;
      }
      if (isLow) {
        exposed++;
        beachBaseDot(b, color, 1).addTo(markerLayer);
        addSlugPins(b, color);
      } else {
        beachBaseDot(b, color, 0.22).addTo(markerLayer);
      }
    }
    tideNote.textContent = hourFilter
      ? `${exposed} of ${plan.beaches.length} sites exposed (tide ≤ ${LOW_TIDE_FT.toFixed(0)} ft) at ${fmtMinute(tideMinute)}`
      : `${exposed} of ${plan.beaches.length} sites with a daylight low tide today`;
  } else {
    for (const b of plan.beaches) {
      const color = beachColor(b);
      beachBaseDot(b, color, 1).addTo(markerLayer);
      addSlugPins(b, color);
    }
  }
}

function beachBaseDot(b, color, opacity) {
  return L.circleMarker([b.lat, b.lon], {
    radius: 3.5, color: "#fff", weight: 1, fillColor: color, fillOpacity: opacity,
  });
}

// addSlugPins places each of a beach's top species at its mean sighting
// location, as an image pin ringed in the beach's color.
function addSlugPins(b, color) {
  const MAX_PER_BEACH = 8;
  const species = (b.species || []).slice(0, MAX_PER_BEACH);
  for (const s of species) {
    // Real averaged sighting location; fall back to the beach point if missing.
    const lat = s.lat || b.lat;
    const lon = s.lon || b.lon;
    const icon = L.divIcon({
      className: "slug-pin-wrap",
      html: `<div class="slug-pin" style="border-color:${color}">
               <img src="${slugImg(s.scientific)}" alt="${s.commonName}"
                    onerror="this.onerror=null;this.src='${SLUG_FALLBACK}'">
               <span class="slug-pin-count">${s.count}</span>
             </div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
    const m = L.marker([lat, lon], { icon, riseOnHover: true });
    m.bindPopup(
      `<div class="slug-pop"><img src="${slugImg(s.scientific)}" onerror="this.onerror=null;this.src='${SLUG_FALLBACK}'">` +
        `<strong>${s.commonName}</strong><em>${s.scientific}</em>` +
        `<span>${s.count} sightings · ${b.name}</span>` +
        `<a href="${inatLink(s)}" target="_blank" rel="noopener">View on iNaturalist →</a></div>`,
      { maxWidth: 240 }
    );
    m.on("click", () => scrollToBeach(b));
    m.addTo(markerLayer);
  }
}

// --- client-side data + NOAA tides (no backend needed) ---
//
// This app is fully static: the precomputed beach/species datasets are plain
// JSON files, and tide predictions come straight from NOAA's keyless, CORS-
// enabled API in the browser. That lets the whole thing be hosted on a static
// CDN (e.g. GitHub Pages) with no server.

const WAKE_START = 8; // earliest waking hour for a usable low tide (inclusive)
const WAKE_END = 20; // latest waking hour (exclusive)
const TIDE_CONCURRENCY = 6; // polite parallelism for NOAA calls

let BEACHES = [];
let SPECIES = { generatedAt: "", beaches: {} };
const tideCache = new Map(); // "station|date" -> Promise<Extreme[]>

// fetchExtremes pulls a station's high/low predictions for a date from NOAA and
// normalizes them into the same shape the old Go backend produced. Results are
// cached per station+date so beaches that share a station only fetch once.
function fetchExtremes(station, date) {
  const key = station + "|" + date;
  if (tideCache.has(key)) return tideCache.get(key);
  const compact = date.replace(/-/g, "");
  const url =
    "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=nudibranch" +
    `&begin_date=${compact}&end_date=${compact}&datum=MLLW&station=${station}` +
    "&time_zone=lst_ldt&interval=hilo&units=english&format=json";
  const p = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`NOAA returned ${res.status}`);
      return res.json();
    })
    .then((j) => {
      if (j.error) throw new Error(j.error.message);
      if (!j.predictions || j.predictions.length === 0) throw new Error("no predictions");
      return j.predictions
        .map((p) => {
          const clock = (p.t.split(" ")[1] || "");
          const [hh, mm] = clock.split(":").map(Number);
          const h = parseFloat(p.v);
          return { time: clock, minutes: hh * 60 + mm, heightFt: h, kind: p.type, minus: p.type === "L" && h < 0 };
        })
        .sort((a, b) => a.minutes - b.minutes);
    });
  tideCache.set(key, p);
  return p;
}

function daylightLows(extremes, wakeStart, wakeEnd) {
  return extremes
    .filter((e) => e.kind === "L" && Math.floor(e.minutes / 60) >= wakeStart && Math.floor(e.minutes / 60) < wakeEnd)
    .map((e) => ({ time: e.time, heightFt: e.heightFt, minus: e.minus }))
    .sort((a, b) => a.heightFt - b.heightFt);
}

// mapLimit runs an async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// buildPlan assembles the same structure the old /api/plan endpoint returned,
// entirely in the browser.
async function buildPlan(region, date) {
  const beaches = region === "all" ? BEACHES : BEACHES.filter((b) => b.region === region);
  const month = parseInt(date.split("-")[1], 10);

  const results = await mapLimit(beaches, TIDE_CONCURRENCY, async (b) => {
    const entry = { ...b, lowTides: [], allTides: [], hasLowTide: false, species: [] };
    try {
      const ex = await fetchExtremes(b.station, date);
      entry.allTides = ex;
      const lows = daylightLows(ex, WAKE_START, WAKE_END);
      if (lows.length > 0) {
        entry.lowTides = lows;
        entry.bestTide = lows[0];
        entry.hasLowTide = true;
        entry.species = (SPECIES.beaches[b.id] && SPECIES.beaches[b.id][String(month)]) || [];
      }
    } catch (err) {
      entry.tideError = err.message;
    }
    return entry;
  });

  results.sort((a, b) => {
    if (a.hasLowTide !== b.hasLowTide) return a.hasLowTide ? -1 : 1;
    if (a.hasLowTide) return a.bestTide.heightFt - b.bestTide.heightFt;
    return 0;
  });

  return {
    region,
    date,
    month,
    wakeStart: WAKE_START,
    wakeEnd: WAKE_END,
    speciesDataAt: SPECIES.generatedAt,
    beaches: results,
  };
}

async function loadPlan() {
  summary.textContent = "Loading tides…";
  try {
    render(await buildPlan(regionSel.value, dateInput.value));
  } catch (err) {
    summary.textContent = "Failed to load plan: " + err.message;
  }
}

function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// init loads the static datasets, fills the region/date controls, then plans.
async function init() {
  summary.textContent = "Loading…";
  try {
    const [beaches, species] = await Promise.all([
      fetch("data/beaches.json").then((r) => r.json()),
      fetch("data/species.json").then((r) => r.json()),
    ]);
    BEACHES = beaches;
    SPECIES = species;

    const regions = [...new Set(BEACHES.map((b) => b.region))].sort();
    regionSel.innerHTML =
      regions.map((r) => `<option value="${r}"${r === "Seattle" ? " selected" : ""}>${r}</option>`).join("") +
      `<option value="all">All PNW</option>`;
    if (!dateInput.value) dateInput.value = todayStr();

    loadPlan();
  } catch (err) {
    summary.textContent = "Failed to load data: " + err.message;
  }
}

init();
