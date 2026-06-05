#!/usr/bin/env sh
# Pull Leaflet's CSS/JS local so the front-end has zero CDN dependencies.
# Run this once where outbound network is allowed, then switch the two CDN
# <link>/<script> tags in web/templates/index.html to point at:
#   /static/vendor/leaflet.css   and   /static/vendor/leaflet.js
#
# Keeping these files local (rather than loading from unpkg) means your site
# has no third-party runtime dependency and keeps working if a CDN is down or
# compromised.
set -eu

VERSION="1.9.4"
DEST="web/static/vendor"
BASE="https://unpkg.com/leaflet@${VERSION}/dist"

mkdir -p "$DEST"
echo "Fetching Leaflet ${VERSION} into ${DEST}/ ..."
curl -fsSL "${BASE}/leaflet.css" -o "${DEST}/leaflet.css"
curl -fsSL "${BASE}/leaflet.js" -o "${DEST}/leaflet.js"
# Leaflet's CSS references marker/layers images relatively.
mkdir -p "${DEST}/images"
for img in marker-icon.png marker-icon-2x.png marker-shadow.png layers.png layers-2x.png; do
  curl -fsSL "${BASE}/images/${img}" -o "${DEST}/images/${img}"
done
echo "Done. Now repoint the Leaflet tags in web/templates/index.html at /static/vendor/."
