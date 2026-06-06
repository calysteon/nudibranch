// Package species serves the precomputed "which nudibranchs are likely at this
// beach in this month" dataset. The heavy lifting (aggregating thousands of
// iNaturalist observations) happens offline in the fetch-inat batch job; at
// request time this package is just a fast in-memory lookup.
package species

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"strconv"
)

// Species is one likely-to-be-seen sea slug at a beach in a given month.
type Species struct {
	CommonName string  `json:"commonName"`
	Scientific string  `json:"scientific"`
	Count      int     `json:"count"`   // historical observations near this beach in this month
	TaxonID    int     `json:"taxonId"` // iNaturalist taxon id (for deep links)
	Lat        float64 `json:"lat"`     // mean latitude of this species' sightings near the beach
	Lon        float64 `json:"lon"`     // mean longitude of this species' sightings near the beach
	PhotoURL   string  `json:"photoUrl,omitempty"`
}

// Dataset maps beachID -> month ("1".."12") -> ranked species list.
type Dataset struct {
	byBeachMonth map[string]map[string][]Species
	generatedAt  string
}

type fileFormat struct {
	GeneratedAt string                          `json:"generatedAt"`
	Beaches     map[string]map[string][]Species `json:"beaches"`
}

// Load reads species.json from the supplied filesystem.
func Load(fsys fs.FS, name string) (*Dataset, error) {
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, fmt.Errorf("read species: %w", err)
	}
	var f fileFormat
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse species: %w", err)
	}
	return &Dataset{byBeachMonth: f.Beaches, generatedAt: f.GeneratedAt}, nil
}

// Likely returns the ranked species expected at beachID during the given month
// (1-12). Returns nil when there is no data, which the caller should treat as
// "no recorded sightings" rather than an error.
func (d *Dataset) Likely(beachID string, month int) []Species {
	byMonth, ok := d.byBeachMonth[beachID]
	if !ok {
		return nil
	}
	return byMonth[strconv.Itoa(month)]
}

// GeneratedAt reports when the dataset was built, for display in the UI.
func (d *Dataset) GeneratedAt() string { return d.generatedAt }
