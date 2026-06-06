# Deploying Nudibranch (free, on GitHub Pages)

This site is **fully static**: the beach and species datasets are plain JSON
files, and tide predictions are fetched in the browser straight from NOAA's
free, keyless, CORS-enabled API. There is **no server to run** and **no usage
billing** - GitHub Pages serves it for free, and the worst case for a traffic
spike is that the CDN gets busy, never a surprise bill.

## One-time setup

1. Push to `main` (the repo already has `.github/workflows/pages.yml`, which
   triggers on `main`).
2. In the repo on github.com: **Settings → Pages → Build and deployment →
   Source: GitHub Actions**.  (NOT "Deploy from a branch" - this site is
   assembled by the workflow, so a plain branch deploy would 404.)
3. The repo must be **public** (or you need GitHub Pro for private Pages).
4. On the **Actions** tab, open the latest "Deploy to GitHub Pages" run and
   re-run it if it failed before Pages was enabled.

That's it. Every push to `main` rebuilds and republishes the site.

Your site will be at:

    https://calysteon.github.io/nudibranch/

(This is a *project* site - the repo is `calysteon/nudibranch` - so it lives at
the `/nudibranch/` subpath. All asset paths are relative, so that just works. A
root `https://<name>.github.io/` URL is only possible if the repo is owned by a
user or organization literally named `<name>`.)

(The `Actions` tab shows each deploy; the green check links to the live URL.)

## How a deploy works

The workflow assembles a static bundle and publishes it - no Go build needed:

    _site/
      index.html              # from web/templates/index.html
      static/...              # app.js, style.css, images, slug thumbnails
      data/beaches.json       # the curated beaches
      data/species.json       # precomputed iNaturalist sightings

The browser then loads those JSON files and calls NOAA per beach for live tides.

## Updating the data

The sightings are precomputed. To refresh them (needs network):

    make fetch        # regenerates data/species.json from live iNaturalist
    git commit -am "Refresh species data"
    git push          # the Pages workflow redeploys automatically

To add or edit beaches, change `data/beaches.json` (each beach needs a NOAA
tide-prediction `station` id), then `make fetch` and push.

## Previewing the static site locally

    make site                              # builds _site/
    cd _site && python3 -m http.server 8000
    # open http://localhost:8000

Or run the Go dev server (serves the same files plus a /data/ route):

    make run                               # http://localhost:8080

## Custom domain (optional, ~$10–15/yr)

Buy a domain, add a `CNAME` file (or set it under Settings → Pages → Custom
domain), and point a DNS `CNAME` record at `calysteon.github.io`. GitHub
provisions HTTPS automatically. This is the only thing that ever costs money.

## Notes

- `species.json` (~1 MB) is fetched once per visit and gzipped by the CDN to
  ~150 KB; slug thumbnails (~7 KB each) load on demand.
- The Go server in `cmd/server` is now optional - handy for local dev, but the
  production site needs nothing but the static files.
