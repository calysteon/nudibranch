.PHONY: build run test fetch vendor site clean

# Build the self-contained server binary.
build:
	go build -o nudibranch ./cmd/server

# Assemble the static site into _site/ (same layout GitHub Pages publishes).
# Preview it with any static server, e.g.:  cd _site && python3 -m http.server
site:
	rm -rf _site
	mkdir -p _site/static _site/data
	cp web/templates/index.html _site/index.html
	cp -r web/static/. _site/static/
	cp data/beaches.json data/species.json _site/data/
	@echo "Built _site/ — preview: (cd _site && python3 -m http.server 8000)"

# Run the server with the embedded sample data.
run:
	go run ./cmd/server

test:
	go test ./...

# Refresh data/species.json from live iNaturalist (needs network access).
fetch:
	go run ./cmd/fetch-inat -beaches data/beaches.json -out data/species.json

# Pull Leaflet local so the front-end has no CDN dependency (needs network).
vendor:
	./scripts/vendor.sh

clean:
	rm -f nudibranch fetch-inat
	rm -rf tidecache _site
