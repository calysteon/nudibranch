// Package beaches loads the curated list of Pacific Northwest tidepooling
// spots. Each beach is hand-picked for accessibility and intertidal life, and
// is associated with the nearest NOAA tide-prediction station.
package beaches

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
)

// Beach is a single curated tidepooling location.
type Beach struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Region  string  `json:"region"`
	Station string  `json:"station"` // NOAA CO-OPS station ID
	Blurb   string  `json:"blurb"`
}

// Set is an immutable collection of beaches with convenient lookups.
type Set struct {
	all  []Beach
	byID map[string]Beach
}

// Load reads beaches.json from the supplied filesystem.
func Load(fsys fs.FS, name string) (*Set, error) {
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, fmt.Errorf("read beaches: %w", err)
	}
	var list []Beach
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, fmt.Errorf("parse beaches: %w", err)
	}
	byID := make(map[string]Beach, len(list))
	for _, beach := range list {
		byID[beach.ID] = beach
	}
	return &Set{all: list, byID: byID}, nil
}

// All returns every beach.
func (s *Set) All() []Beach { return s.all }

// Get returns a beach by ID.
func (s *Set) Get(id string) (Beach, bool) {
	b, ok := s.byID[id]
	return b, ok
}

// InRegion returns beaches matching region. The sentinel "all" returns
// everything.
func (s *Set) InRegion(region string) []Beach {
	if region == "" || region == "all" {
		return s.all
	}
	var out []Beach
	for _, b := range s.all {
		if b.Region == region {
			out = append(out, b)
		}
	}
	return out
}

// Regions returns the distinct region names, sorted.
func (s *Set) Regions() []string {
	seen := map[string]bool{}
	var out []string
	for _, b := range s.all {
		if !seen[b.Region] {
			seen[b.Region] = true
			out = append(out, b.Region)
		}
	}
	sort.Strings(out)
	return out
}
