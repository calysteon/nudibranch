# 🐌 Nudibranch

A tidepool planner for the Pacific Northwest. Pick an **area** and a **date**;
it shows which nearby beaches have a **low tide during waking hours** and which
**nudibranchs** you're likely to find there that month, based on historical
iNaturalist sightings.

It correlates two free data sources:

- **Tides** - [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) (no API key).
- **Sea slug sightings** - [iNaturalist](https://www.inaturalist.org/) (no API key).

## Design at a glance

The expensive question - *which species at which beach in which month* - does
not change minute to minute, so it's **precomputed** offline by `cmd/fetch-inat`
into `data/species.json`. A live request is then cheap: fetch the day's tide
extremes from NOAA, keep the lows that land in waking hours, and join them with
the precomputed species table.

```
cmd/server      HTTP server: map UI + /api/plan (tides ⨝ species)
cmd/fetch-inat  Batch job: iNaturalist  ->  data/species.json
internal/tides  NOAA client + daylight-low-tide filter  (unit-tested)
internal/species  Loads + serves the precomputed dataset
internal/beaches  Curated beach list (coords + NOAA station)
web/            HTML template + vanilla JS + Leaflet map (no npm build)
data/           beaches.json (curated) + species.json (sample; regenerate)
```

The backend is **Go standard library only** - no third-party server
dependencies, compiles to a single static binary. The only browser dependency
is Leaflet, loaded from a CDN by default; run `make vendor` to host it locally.

## Run it

```sh
make run          # serves http://localhost:8080 with embedded sample data
make test         # runs the unit tests
```

Flags (see `go run ./cmd/server -h`): `-addr`, `-region`, `-data`,
`-cache`, `-wake-start`, `-wake-end`.

## Get real data

The repo ships **sample** species data so it runs immediately. To populate real
iNaturalist data (needs outbound network):

```sh
make fetch        # writes data/species.json from live iNaturalist
```

## Deploy to a VPS

```sh
GOOS=linux GOARCH=amd64 go build -o nudibranch ./cmd/server   # one static binary
scp nudibranch data/*.json youruser@yourvps:/opt/nudibranch/
# then install deploy/nudibranch.service (see its header) and front it with TLS
```

See `CLAUDE.md` for the current status, known gaps, and the roadmap.
