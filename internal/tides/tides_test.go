package tides

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A canned NOAA hilo response for one day with two lows and two highs. One low
// is pre-dawn (03:24) and must be filtered out of the waking window; the other
// (14:32, a minus tide) must survive.
const sampleNOAA = `{"predictions":[
  {"t":"2026-06-15 03:24","v":"1.20","type":"L"},
  {"t":"2026-06-15 09:10","v":"7.80","type":"H"},
  {"t":"2026-06-15 14:32","v":"-0.50","type":"L"},
  {"t":"2026-06-15 21:05","v":"8.10","type":"H"}
]}`

func newTestClient(body string, status int) (*Client, *httptest.Server) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	c := New("")
	c.base = srv.URL
	return c, srv
}

func TestDaylightLowTidesFiltersAndSorts(t *testing.T) {
	c, srv := newTestClient(sampleNOAA, http.StatusOK)
	defer srv.Close()

	lows, err := c.DaylightLowTides(context.Background(), "9447130", "2026-06-15", 8, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lows) != 1 {
		t.Fatalf("expected 1 daylight low tide, got %d: %+v", len(lows), lows)
	}
	got := lows[0]
	if got.Time != "14:32" {
		t.Errorf("time = %q, want 14:32", got.Time)
	}
	if got.HeightFt != -0.5 {
		t.Errorf("height = %v, want -0.5", got.HeightFt)
	}
	if !got.Minus {
		t.Errorf("expected Minus=true for sub-zero tide")
	}
}

func TestDaylightLowTidesWiderWindowKeepsPreDawn(t *testing.T) {
	c, srv := newTestClient(sampleNOAA, http.StatusOK)
	defer srv.Close()

	// Window starting at 03:00 should now include the 03:24 low as well.
	lows, err := c.DaylightLowTides(context.Background(), "9447130", "2026-06-15", 3, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lows) != 2 {
		t.Fatalf("expected 2 low tides, got %d", len(lows))
	}
	// Sorted lowest-first: the -0.5 minus tide leads.
	if lows[0].HeightFt != -0.5 || lows[1].HeightFt != 1.2 {
		t.Errorf("not sorted by height: %+v", lows)
	}
}

func TestIsCacheablePredictions(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"valid predictions", sampleNOAA, true},
		{"error payload", `{"error":{"message":"No Predictions data was found."}}`, false},
		{"empty predictions", `{"predictions":[]}`, false},
		{"garbage", `not json`, false},
	}
	for _, c := range cases {
		if got := isCacheablePredictions([]byte(c.body)); got != c.want {
			t.Errorf("%s: isCacheablePredictions = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestDaylightLowTidesNOAAError(t *testing.T) {
	c, srv := newTestClient(`{"error":{"message":"No data was found."}}`, http.StatusOK)
	defer srv.Close()

	_, err := c.DaylightLowTides(context.Background(), "0000000", "2026-06-15", 8, 20)
	if err == nil {
		t.Fatal("expected error from NOAA error payload, got nil")
	}
}
