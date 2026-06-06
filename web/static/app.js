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

let currentPlan = null;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  loadPlan();
});

// Slug pins are offset around their beach in screen pixels, so re-lay them out
// whenever the zoom level changes.
map.on("zoomend", () => {
  if (currentPlan) renderMarkers(currentPlan);
});

function inatLink(s) {
  if (s.taxonId && s.taxonId > 0) {
    return `https://www.inaturalist.org/taxa/${s.taxonId}`;
  }
  return `https://www.inaturalist.org/observations?taxon_name=${encodeURIComponent(s.scientific)}`;
}

// slugImg builds the local thumbnail URL for a species from its scientific name
// ("Aeolidia loui" -> "/static/slugs/aeolidia_loui.jpg").
function slugImg(scientific) {
  return "/static/slugs/" + scientific.toLowerCase().replace(/\s+/g, "_") + ".jpg";
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
  return `<span class="${cls}" title="${t.minus ? "Minus tide — excellent" : "Low tide"}">${t.time} · ${ft} ft</span>`;
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
           <a class="sp-photo" href="${inatLink(s)}" target="_blank" rel="noopener" title="${s.commonName} — view on iNaturalist">
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
  let inner = `<h3><span class="swatch" style="background:${beachColor(b)}"></span>${b.name}</h3><p class="blurb">${b.blurb}</p>`;

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
  return li;
}

function scrollToBeach(b) {
  const card = document.getElementById("beach-" + b.id);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
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

  renderMarkers(plan);

  const bounds = plan.beaches.map((b) => [b.lat, b.lon]);
  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
  }
}

// renderMarkers redraws the map: each species sighting becomes an image pin,
// ringed in its beach's identity color and offset around the beach point.
function renderMarkers(plan) {
  markerLayer.clearLayers();
  renderSlugMarkers(plan);
}

// Slug view: each species sighting becomes an image pin, ringed in its beach's
// identity color and offset around the beach point so they fan out.
function renderSlugMarkers(plan) {
  const MAX_PER_BEACH = 8;
  for (const b of plan.beaches) {
    const color = beachColor(b);
    const species = (b.species || []).slice(0, MAX_PER_BEACH);

    // Small base dot marks the beach itself.
    L.circleMarker([b.lat, b.lon], {
      radius: 3.5, color: "#fff", weight: 1, fillColor: color, fillOpacity: 1,
    }).addTo(markerLayer);

    if (species.length === 0) continue;

    const base = map.latLngToLayerPoint([b.lat, b.lon]);
    const n = species.length;
    // Size the ring so the pins fan out without heavy overlap.
    const ring = n === 1 ? 0 : Math.max(30, Math.round((n * 40) / (2 * Math.PI)));
    species.forEach((s, i) => {
      const ang = (i / species.length) * 2 * Math.PI - Math.PI / 2;
      const pt = L.point(base.x + ring * Math.cos(ang), base.y + ring * Math.sin(ang));
      const ll = map.layerPointToLatLng(pt);
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
      const m = L.marker(ll, { icon, riseOnHover: true });
      m.bindPopup(
        `<div class="slug-pop"><img src="${slugImg(s.scientific)}" onerror="this.onerror=null;this.src='${SLUG_FALLBACK}'">` +
          `<strong>${s.commonName}</strong><em>${s.scientific}</em>` +
          `<span>${s.count} sightings · ${b.name}</span>` +
          `<a href="${inatLink(s)}" target="_blank" rel="noopener">View on iNaturalist →</a></div>`,
        { maxWidth: 240 }
      );
      m.on("click", () => scrollToBeach(b));
      m.addTo(markerLayer);
    });
  }
}

async function loadPlan() {
  const params = new URLSearchParams({
    region: regionSel.value,
    date: dateInput.value,
  });
  summary.textContent = "Loading…";
  try {
    const res = await fetch("/api/plan?" + params.toString());
    if (!res.ok) throw new Error(await res.text());
    render(await res.json());
  } catch (err) {
    summary.textContent = "Failed to load plan: " + err.message;
  }
}

loadPlan();
