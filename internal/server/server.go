// Package server wires the beaches, tides, and species datasets into an HTTP
// service: an HTML map UI at "/" and a JSON planning endpoint at "/api/plan".
package server

import (
	"context"
	"encoding/json"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/calysteon/nudibranch/internal/beaches"
	"github.com/calysteon/nudibranch/internal/species"
	"github.com/calysteon/nudibranch/internal/tides"
)

// pacific is the reference timezone for "today" and for interpreting waking
// hours. The whole supported region currently shares this zone.
var pacific = mustLoadZone("America/Los_Angeles")

// Config holds everything the server needs to run.
type Config struct {
	WebFS         fs.FS
	DataFS        fs.FS // serves beaches.json/species.json at /data/ for the static front-end
	Beaches       *beaches.Set
	Species       *species.Dataset
	Tides         *tides.Client
	WakeStart     int    // inclusive local hour, e.g. 8
	WakeEnd       int    // exclusive local hour, e.g. 20
	DefaultRegion string // e.g. "Seattle"
}

// Server is the HTTP handler.
type Server struct {
	cfg  Config
	tmpl *template.Template
	mux  *http.ServeMux
}

// New constructs a Server, parsing templates from the embedded web FS.
func New(cfg Config) (*Server, error) {
	tmpl, err := template.ParseFS(cfg.WebFS, "web/templates/*.html")
	if err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, tmpl: tmpl, mux: http.NewServeMux()}

	static, err := fs.Sub(cfg.WebFS, "web/static")
	if err != nil {
		return nil, err
	}
	s.mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(static))))
	if cfg.DataFS != nil {
		// The static front-end fetches the datasets directly, mirroring how they
		// are served on a static host (e.g. GitHub Pages).
		s.mux.Handle("/data/", http.StripPrefix("/data/", http.FileServer(http.FS(cfg.DataFS))))
	}
	s.mux.HandleFunc("/api/plan", s.handlePlan)
	s.mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	s.mux.HandleFunc("/", s.handleIndex)
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// handleIndex renders the map UI shell. The actual data is fetched by the
// browser from /api/plan so the page is cheap and cacheable.
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data := struct {
		Regions       []string
		DefaultRegion string
		DefaultDate   string
		WakeStart     int
		WakeEnd       int
	}{
		Regions:       s.cfg.Beaches.Regions(),
		DefaultRegion: s.cfg.DefaultRegion,
		DefaultDate:   time.Now().In(pacific).Format("2006-01-02"),
		WakeStart:     s.cfg.WakeStart,
		WakeEnd:       s.cfg.WakeEnd,
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.tmpl.ExecuteTemplate(w, "index.html", data); err != nil {
		log.Printf("render index: %v", err)
	}
}

// planBeach is one beach's entry in the planning response.
type planBeach struct {
	beaches.Beach
	LowTides   []tides.LowTide   `json:"lowTides"`
	BestTide   *tides.LowTide    `json:"bestTide"`
	AllTides   []tides.Extreme   `json:"allTides"` // full day's highs+lows for the curve
	HasLowTide bool              `json:"hasLowTide"`
	Species    []species.Species `json:"species"`
	TideError  string            `json:"tideError,omitempty"`
}

type planResponse struct {
	Region      string      `json:"region"`
	Date        string      `json:"date"`
	Month       int         `json:"month"`
	WakeStart   int         `json:"wakeStart"`
	WakeEnd     int         `json:"wakeEnd"`
	GeneratedAt string      `json:"speciesDataAt"`
	Beaches     []planBeach `json:"beaches"`
}

func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	if region == "" {
		region = s.cfg.DefaultRegion
	}
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().In(pacific).Format("2006-01-02")
	}
	day, err := time.ParseInLocation("2006-01-02", date, pacific)
	if err != nil {
		http.Error(w, "invalid date; expected YYYY-MM-DD", http.StatusBadRequest)
		return
	}
	month := int(day.Month())

	list := s.cfg.Beaches.InRegion(region)
	results := make([]planBeach, len(list))

	// Fan out the NOAA calls - each beach is independent. Cap concurrency so we
	// stay polite to NOAA even when a region has many beaches.
	const maxConcurrent = 6
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	for i, b := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, b beaches.Beach) {
			defer wg.Done()
			defer func() { <-sem }()

			entry := planBeach{Beach: b}
			extremes, err := s.cfg.Tides.DayExtremes(ctx, b.Station, date)
			if err != nil {
				entry.TideError = err.Error()
			} else {
				entry.AllTides = extremes
				lows := tides.DaylightLows(extremes, s.cfg.WakeStart, s.cfg.WakeEnd)
				if len(lows) > 0 {
					entry.LowTides = lows
					entry.BestTide = &lows[0] // already sorted lowest-first
					entry.HasLowTide = true
					entry.Species = s.cfg.Species.Likely(b.ID, month)
				}
			}
			results[i] = entry
		}(i, b)
	}
	wg.Wait()

	// Sort: beaches with a daylight low tide first, best (lowest) tide leading.
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].HasLowTide != results[j].HasLowTide {
			return results[i].HasLowTide
		}
		if results[i].HasLowTide {
			return results[i].BestTide.HeightFt < results[j].BestTide.HeightFt
		}
		return false
	})

	resp := planResponse{
		Region:      region,
		Date:        date,
		Month:       month,
		WakeStart:   s.cfg.WakeStart,
		WakeEnd:     s.cfg.WakeEnd,
		GeneratedAt: s.cfg.Species.GeneratedAt(),
		Beaches:     results,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("encode plan: %v", err)
	}
}

func mustLoadZone(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}
