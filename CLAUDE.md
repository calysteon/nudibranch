# CLAUDE.md — project status, gaps, and roadmap

Guidance for working in this repo, plus an honest accounting of what is built,
what is **unverified**, and what is **missing**. Read the "Verification status"
and "What's missing" sections before trusting any number this app shows.

## What this project is

A Pacific Northwest tidepool planner. Given an **area** + **date**, it shows
which nearby beaches have a **low tide during waking hours** and which
**nudibranchs** are likely there that month (from historical iNaturalist data).
It joins two free, keyless APIs: **NOAA CO-OPS** (tides) and **iNaturalist**
(sightings).

## Architecture (one-paragraph version)

The species-by-beach-by-month table is **precomputed offline** by
`cmd/fetch-inat` into `data/species.json`. Live requests are cheap: `cmd/server`
fetches the day's tide extremes from NOAA, filters to waking-hour lows, and
joins with the precomputed species table. Go stdlib only on the backend
(single static binary); the only browser dependency is Leaflet.

```
cmd/server         HTTP server: map UI ("/") + JSON planner ("/api/plan")
cmd/fetch-inat     Batch job: iNaturalist -> data/species.json
internal/tides     NOAA client + DaylightLowTides() filter   <-- the core logic
internal/species   Loads/serves the precomputed dataset
internal/beaches   Curated beach list (coords + NOAA station id)
web/               index.html template, app.js, style.css (Leaflet map)
data/              beaches.json (curated), species.json (SAMPLE — regenerate)
```

## Commands

```sh
make run     # server on :8080 with embedded sample data
make test    # unit tests (currently: internal/tides)
make fetch   # regenerate data/species.json from live iNaturalist (needs net)
make vendor  # download Leaflet locally (needs net)
make build   # static binary -> ./nudibranch
```

Always run `gofmt -w .` and `go vet ./...` before committing.

---

## Verification status — READ THIS

This was built in a sandbox whose **network policy blocks outbound hosts**
(`api.tidesandcurrents.noaa.gov` and `api.inaturalist.org` both return "Host not
in allowlist"). So the live API paths have **never run against the real APIs
here.** Here is exactly what is and isn't proven.

| Piece | Status | How it was checked |
|---|---|---|
| NOAA response **parsing** (`predictions[].t/v/type`) | ✅ Verified against a *canned* payload | `internal/tides/tides_test.go` |
| **Daylight filter** (keep type=="L" within `[wakeStart,wakeEnd)`) | ✅ Verified | same test, incl. pre-dawn exclusion |
| Low-tide **sorting** (lowest height first) + minus-tide flag | ✅ Verified | same test |
| NOAA **error payload** handling | ✅ Verified | same test |
| NOAA **live HTTP call** (URL params, real JSON, time zones) | ⚠️ **Unverified** | blocked by sandbox allowlist |
| iNaturalist **fetch + pagination** (`cmd/fetch-inat`) | ⚠️ **Unverified** | never run against live API |
| Server wiring + `/api/plan` JSON shape | ✅ Verified | smoke test (returned graceful `tideError`) |
| Front-end map render | ⚠️ **Unverified** | not opened in a browser in-sandbox |
| Beach coordinates & NOAA **station IDs** | ⚠️ Partly trusted | see below |
| **Species data** | ❌ **Sample/fake** | hand-written placeholder |

### What to verify first, the moment you have network

1. `make fetch` and confirm it paginates and writes a real `data/species.json`.
2. `make run`, open `http://localhost:8080`, confirm the map renders and a real
   beach shows real low-tide times.
3. Spot-check one beach's tide time against the NOAA website for the same date.

---

## What's missing / needs work (the punch list)

### 1. NOAA tide integration — assumptions to confirm
- **Live call unproven.** The request in `tides.go:rawPredictions` uses
  `interval=hilo`, `datum=MLLW`, `time_zone=lst_ldt`, `units=english`,
  `format=json`. These are believed correct but must be confirmed against a
  live 200 response. Watch for: the exact `t` format (`"2006-01-02 15:04"`),
  and that `type` is `"H"`/`"L"`.
- **Time handling is naive.** We parse only the clock `HH:MM` string and never
  build a real `time.Time`, so the waking-hour filter trusts NOAA's
  `lst_ldt` local time. Fine today (whole region is Pacific), but revisit if we
  expand beyond one time zone.
- **Cache invalidation.** `tidecache/` never expires. Predictions are stable so
  this is OK, but there's no max-age/cleanup; add one before long-running prod.
- **No rate limiting / retry/backoff** on NOAA calls. Add retry with backoff
  and a small client-side limiter if a region grows to many stations.

### 2. Daylight window — currently a hard 08:00–20:00, not real daylight
- The "during waking hours" rule is a fixed `[wake-start, wake-end)` hour
  window (default 8–20). The user's actual intent is **sunlit hours**, which
  vary by date and latitude (PNW summer ≈ 5am–9pm, winter ≈ 8am–4:30pm).
- **TODO:** add a sunrise/sunset calculation (NOAA solar position algorithm,
  ~40 lines, no deps) and filter lows to `max(wakeStart, sunrise) ..
  min(wakeEnd, sunset)`. Display sunrise/sunset in the UI.

### 3. Species data — entirely a placeholder
- `data/species.json` is **hand-written sample data** with `taxonId: 0` and
  invented counts. It only covers month 6 for most beaches (plus 4 & 12 for
  Alki) to demo seasonality.
- **TODO:** run `cmd/fetch-inat` to replace it. Until then, every species list
  in the UI is fictional.
- The UI banner shows `speciesDataAt` ("sample data…") so this is visible.

### 4. iNaturalist batch job — unproven assumptions
- **Taxon ID `47113`** is assumed to be Nudibranchia — **verify** (open
  `inaturalist.org/taxa/47113`). Note nudibranchs are paraphyletic on iNat;
  consider also pulling sea slug sisters (e.g. include Aeolidida/Cladobranchia
  parents) if coverage looks thin.
- Response field assumptions to confirm against live JSON: `geojson.coordinates`
  as `[lng,lat]`, `observed_on_details.month`, `taxon.rank == "species"`,
  `taxon.preferred_common_name`.
- **Obscured coordinates:** iNat fuzzes locations for sensitive/threatened taxa
  (~0.2° random offset). That can misassign an observation to the wrong beach.
  Consider filtering `geoprivacy=open` or widening `-radius`.
- **Attribution model is naive:** each observation goes to the single nearest
  beach within `-radius` km (default 8). Beaches closer than 16 km apart will
  split/steal each other's sightings. Consider per-beach radius or de-dup.
- No incremental updates — it refetches everything each run. Fine for now.

### 5. Beaches dataset — small and partly unverified
- Only **9 beaches** across 4 regions. Seattle cluster all map to station
  `9447130` (high confidence). Other stations (`9444090` Port Angeles,
  `9449880` Friday Harbor, `9449211` Bellingham) are believed correct but
  **should be confirmed**, and each beach's nearest station re-checked.
- **TODO:** expand the curated list; verify each `station` is the genuinely
  nearest active NOAA prediction station; double-check lat/lon.
- No per-beach substrate/quality metadata beyond a prose blurb.

### 6. Front-end gaps
- **Not opened in a browser yet** — verify the map, markers, popups, and the
  date picker actually work end-to-end.
- Leaflet loads from the **unpkg CDN** (see `index.html`). For a no-third-party
  deploy, run `make vendor` and repoint the two tags at `/static/vendor/`.
  Consider adding Subresource Integrity (SRI) hashes if staying on the CDN.
- No loading spinner beyond a "Loading…" text; no per-beach error toast; no
  mobile layout pass; no species photos (the `photoUrl` field exists but is
  unused — `fetch-inat` doesn't populate it yet).
- No "use my location" / geolocation; area selection is a fixed region dropdown.

### 7. Product features not yet built
- **Sunrise/sunset display** and true-daylight filtering (see §2).
- **Tide curve / multi-day view** ("show me the best low tides this week").
- **Species detail** (photo, description, link) — currently just a name + iNat
  link.
- **Ranking/score** combining tide lowness + species richness into a single
  "go here" score.
- Expansion beyond PNW (would need multi-timezone handling, see §1).

### 8. Operational / security
- No HTTPS in-app — terminate TLS at nginx/Caddy (see `deploy/`).
- No request logging, metrics, or graceful shutdown on SIGTERM.
- No CI workflow yet (add `go test ./...` + `go vet` on push).
- `deploy/nudibranch.service` exists but is **untested on a real VPS**.

---

## Conventions
- Backend stays **stdlib-only** unless there's a strong reason; keep the
  dependency surface tiny (a deliberate security choice).
- No npm / node_modules / build step for the front-end. Vanilla JS + Leaflet.
- Data shape changes must stay in sync across: `internal/species`,
  `cmd/fetch-inat` (`fileFormat`), and `data/species.json`.
- Keep `data/species.json`'s `generatedAt` honest — it's shown to users.
