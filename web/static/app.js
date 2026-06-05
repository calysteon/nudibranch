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

form.addEventListener("submit", (e) => {
  e.preventDefault();
  loadPlan();
});

function inatLink(s) {
  if (s.taxonId && s.taxonId > 0) {
    return `https://www.inaturalist.org/taxa/${s.taxonId}`;
  }
  return `https://www.inaturalist.org/observations?taxon_name=${encodeURIComponent(s.scientific)}`;
}

function tideBadge(t) {
  const cls = t.minus ? "tide minus" : "tide";
  const ft = t.heightFt.toFixed(1);
  return `<span class="${cls}" title="${t.minus ? "Minus tide — excellent" : "Low tide"}">${t.time} · ${ft} ft</span>`;
}

function speciesList(species) {
  if (!species || species.length === 0) {
    return `<p class="none">No recorded sightings here this month.</p>`;
  }
  const items = species
    .map(
      (s) =>
        `<li><a href="${inatLink(s)}" target="_blank" rel="noopener">${s.commonName}</a>
         <span class="sci">${s.scientific}</span>
         <span class="count">(${s.count})</span></li>`
    )
    .join("");
  return `<ul class="species">${items}</ul>`;
}

function renderBeachCard(b) {
  const li = document.createElement("li");
  li.className = "beach" + (b.hasLowTide ? "" : " no-tide");
  let inner = `<h3>${b.name}</h3><p class="blurb">${b.blurb}</p>`;

  if (b.tideError) {
    inner += `<p class="err">Tide data unavailable: ${b.tideError}</p>`;
  } else if (b.hasLowTide) {
    inner += `<div class="tides">${b.lowTides.map(tideBadge).join("")}</div>`;
    inner += speciesList(b.species);
  } else {
    inner += `<p class="none">No daylight low tide on this date.</p>`;
  }
  li.innerHTML = inner;
  return li;
}

function render(plan) {
  markerLayer.clearLayers();
  list.innerHTML = "";

  const withTide = plan.beaches.filter((b) => b.hasLowTide).length;
  summary.textContent = `${plan.date}: ${withTide} of ${plan.beaches.length} beaches have a daylight low tide.`;
  dataNote.textContent = "Species data: " + plan.speciesDataAt;

  const bounds = [];
  for (const b of plan.beaches) {
    const card = renderBeachCard(b);
    list.appendChild(card);

    const color = b.hasLowTide ? (b.bestTide && b.bestTide.minus ? "#b8324a" : "#11707f") : "#999";
    const marker = L.circleMarker([b.lat, b.lon], {
      radius: b.hasLowTide ? 9 : 6,
      color: "#fff",
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.9,
    });

    let popup = `<strong>${b.name}</strong>`;
    if (b.hasLowTide) {
      popup += `<br>Low tide: ${b.lowTides.map((t) => `${t.time} (${t.heightFt.toFixed(1)} ft)`).join(", ")}`;
      popup += `<br>${speciesList(b.species)}`;
    } else if (b.tideError) {
      popup += `<br><em>tide data unavailable</em>`;
    } else {
      popup += `<br><em>no daylight low tide</em>`;
    }
    marker.bindPopup(popup);
    marker.on("click", () => card.scrollIntoView({ behavior: "smooth", block: "center" }));
    marker.addTo(markerLayer);
    bounds.push([b.lat, b.lon]);
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
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
