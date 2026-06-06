// Command server runs the Nudibranch tide-and-sea-slug planning web app.
//
// By default it serves on :8080 using the sample data embedded in the binary,
// so it runs anywhere with zero setup. Point -data at a directory containing a
// freshly generated species.json (and optionally beaches.json) to serve real
// iNaturalist-derived data without recompiling.
package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	_ "time/tzdata" // embed the timezone database so zones work on minimal hosts

	"github.com/calysteon/nudibranch"
	"github.com/calysteon/nudibranch/internal/beaches"
	"github.com/calysteon/nudibranch/internal/server"
	"github.com/calysteon/nudibranch/internal/species"
	"github.com/calysteon/nudibranch/internal/tides"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "", "directory with beaches.json/species.json (default: embedded sample data)")
	cacheDir := flag.String("cache", "tidecache", "directory for caching NOAA tide responses (\"\" to disable)")
	region := flag.String("region", "Seattle", "default region shown on load")
	wakeStart := flag.Int("wake-start", 8, "earliest waking hour for a usable low tide (inclusive, 0-23)")
	wakeEnd := flag.Int("wake-end", 20, "latest waking hour for a usable low tide (exclusive, 1-24)")
	flag.Parse()

	// Data files come either from the embedded defaults or a runtime directory.
	var dataFS fs.FS = nudibranch.DataFS
	beachPath, speciesPath := "data/beaches.json", "data/species.json"
	if *dataDir != "" {
		dataFS = os.DirFS(*dataDir)
		beachPath, speciesPath = "beaches.json", "species.json"
	}

	beachSet, err := beaches.Load(dataFS, beachPath)
	if err != nil {
		log.Fatalf("load beaches: %v", err)
	}
	speciesSet, err := species.Load(dataFS, speciesPath)
	if err != nil {
		log.Fatalf("load species: %v", err)
	}

	// A filesystem rooted at the JSON files themselves, served at /data/ so the
	// static front-end can fetch them the same way it does on GitHub Pages.
	httpDataFS := dataFS
	if *dataDir == "" {
		if sub, subErr := fs.Sub(dataFS, "data"); subErr == nil {
			httpDataFS = sub
		}
	}

	srv, err := server.New(server.Config{
		WebFS:         nudibranch.WebFS,
		DataFS:        httpDataFS,
		Beaches:       beachSet,
		Species:       speciesSet,
		Tides:         tides.New(*cacheDir),
		WakeStart:     *wakeStart,
		WakeEnd:       *wakeEnd,
		DefaultRegion: *region,
	})
	if err != nil {
		log.Fatalf("build server: %v", err)
	}

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("nudibranch listening on %s (region=%s, waking hours %02d:00-%02d:00)", *addr, *region, *wakeStart, *wakeEnd)
	log.Fatal(httpSrv.ListenAndServe())
}
