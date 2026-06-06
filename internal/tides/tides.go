// Package tides talks to the NOAA CO-OPS API to fetch high/low tide
// predictions and distills them into "daylight low tides" - the low tides that
// fall within human-friendly waking hours, which is when tidepooling is
// actually feasible.
//
// NOAA CO-OPS is a free US government API and requires no key:
// https://api.tidesandcurrents.noaa.gov/api/prod/
package tides

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const apiBase = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"

// LowTide is a single low-tide extreme within the waking window.
type LowTide struct {
	Time     string  `json:"time"`     // local clock time, "15:04"
	HeightFt float64 `json:"heightFt"` // height relative to MLLW datum
	Minus    bool    `json:"minus"`    // true for prized sub-zero ("minus") tides
}

// Extreme is a single high- or low-tide turning point for the day, used to
// draw the tide curve. It spans the whole day, not just the waking window.
type Extreme struct {
	Time     string  `json:"time"`     // local clock time, "15:04"
	Minutes  int     `json:"minutes"`  // minutes since local midnight (for plotting)
	HeightFt float64 `json:"heightFt"` // height relative to MLLW datum
	Kind     string  `json:"kind"`     // "H" or "L"
	Minus    bool    `json:"minus"`    // true for sub-zero lows
}

// Client fetches and caches tide predictions.
type Client struct {
	http     *http.Client
	cacheDir string // optional on-disk cache; "" disables
	base     string // API base URL; overridable in tests
}

// New returns a Client. If cacheDir is non-empty, raw NOAA responses are
// cached there (tide predictions are stable, so this is safe and friendly to
// NOAA's servers).
func New(cacheDir string) *Client {
	if cacheDir != "" {
		_ = os.MkdirAll(cacheDir, 0o755)
	}
	return &Client{
		http:     &http.Client{Timeout: 20 * time.Second},
		cacheDir: cacheDir,
		base:     apiBase,
	}
}

// noaaResponse mirrors the relevant parts of the datagetter JSON payload.
type noaaResponse struct {
	Predictions []struct {
		T    string `json:"t"`    // "2006-01-02 15:04"
		V    string `json:"v"`    // height as a string
		Type string `json:"type"` // "H" or "L"
	} `json:"predictions"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// DayExtremes returns every high/low turning point for the given station and
// date (YYYY-MM-DD), in chronological order. This is the raw material for both
// the tide curve and the daylight-low filter.
func (c *Client) DayExtremes(ctx context.Context, station, date string) ([]Extreme, error) {
	raw, err := c.rawPredictions(ctx, station, date)
	if err != nil {
		return nil, err
	}
	var resp noaaResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse predictions for station %s: %w", station, err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("noaa error for station %s: %s", station, resp.Error.Message)
	}

	var out []Extreme
	for _, p := range resp.Predictions {
		// p.T is local station time, e.g. "2026-06-05 14:32".
		parts := strings.Fields(p.T)
		if len(parts) != 2 {
			continue
		}
		hm := strings.SplitN(parts[1], ":", 2)
		if len(hm) != 2 {
			continue
		}
		hour, err1 := strconv.Atoi(hm[0])
		min, err2 := strconv.Atoi(hm[1])
		if err1 != nil || err2 != nil {
			continue
		}
		height, _ := strconv.ParseFloat(p.V, 64)
		out = append(out, Extreme{
			Time:     parts[1],
			Minutes:  hour*60 + min,
			HeightFt: height,
			Kind:     p.Type,
			Minus:    p.Type == "L" && height < 0,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Minutes < out[j].Minutes })
	return out, nil
}

// DaylightLows filters a day's extremes to the low tides falling within
// [wakeStart, wakeEnd) local hours, sorted by height (lowest/best first). It is
// a pure function so callers that already hold the day's extremes (e.g. to draw
// the curve) don't pay for a second fetch.
func DaylightLows(extremes []Extreme, wakeStart, wakeEnd int) []LowTide {
	var out []LowTide
	for _, e := range extremes {
		if e.Kind != "L" {
			continue
		}
		hour := e.Minutes / 60
		if hour < wakeStart || hour >= wakeEnd {
			continue
		}
		out = append(out, LowTide{Time: e.Time, HeightFt: e.HeightFt, Minus: e.Minus})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HeightFt < out[j].HeightFt })
	return out
}

// DaylightLowTides returns the low tides for the given station and date that
// fall within [wakeStart, wakeEnd) local hours, sorted by height (lowest first).
func (c *Client) DaylightLowTides(ctx context.Context, station, date string, wakeStart, wakeEnd int) ([]LowTide, error) {
	extremes, err := c.DayExtremes(ctx, station, date)
	if err != nil {
		return nil, err
	}
	return DaylightLows(extremes, wakeStart, wakeEnd), nil
}

// rawPredictions returns the raw NOAA JSON body, using the on-disk cache when
// available.
func (c *Client) rawPredictions(ctx context.Context, station, date string) ([]byte, error) {
	compact := strings.ReplaceAll(date, "-", "") // YYYYMMDD
	if c.cacheDir != "" {
		path := filepath.Join(c.cacheDir, fmt.Sprintf("%s_%s.json", station, compact))
		if b, err := os.ReadFile(path); err == nil {
			return b, nil
		}
	}

	q := url.Values{}
	q.Set("product", "predictions")
	q.Set("application", "nudibranch")
	q.Set("begin_date", compact)
	q.Set("end_date", compact)
	q.Set("datum", "MLLW")
	q.Set("station", station)
	q.Set("time_zone", "lst_ldt") // local time, daylight-adjusted
	q.Set("interval", "hilo")     // only high/low extremes
	q.Set("units", "english")     // feet
	q.Set("format", "json")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch tides for station %s: %w", station, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("noaa returned status %d for station %s", resp.StatusCode, station)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read tide response for station %s: %w", station, err)
	}
	// Only cache genuine prediction payloads. NOAA occasionally returns a
	// transient error (e.g. under load); caching that would poison the station
	// for every future request until the cache is manually cleared.
	if c.cacheDir != "" && isCacheablePredictions(b) {
		path := filepath.Join(c.cacheDir, fmt.Sprintf("%s_%s.json", station, compact))
		_ = os.WriteFile(path, b, 0o644)
	}
	return b, nil
}

// isCacheablePredictions reports whether a NOAA body is a real predictions
// payload (at least one prediction, no error) and therefore safe to cache.
func isCacheablePredictions(b []byte) bool {
	var probe struct {
		Predictions []json.RawMessage `json:"predictions"`
		Error       *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return false
	}
	return probe.Error == nil && len(probe.Predictions) > 0
}
