.PHONY: build run test fetch vendor clean

# Build the self-contained server binary.
build:
	go build -o nudibranch ./cmd/server

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
	rm -rf tidecache
