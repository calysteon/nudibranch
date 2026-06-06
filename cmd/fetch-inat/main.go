// Command fetch-inat builds the species dataset the web app serves. It pulls
// nudibranch observations from iNaturalist within a bounding box, assigns each
// observation to the nearest curated beach, buckets them by calendar month, and
// writes a ranked species.json.
//
// Run this offline (where outbound network is allowed), then either commit the
// resulting data/species.json or point the server at it with -data:
//
//	go run ./cmd/fetch-inat -beaches data/beaches.json -out data/species.json
//
// iNaturalist asks API users to stay under ~60 requests/minute; this tool
// sleeps between pages to be a good citizen. Be patient — a full PNW pull can
// take a few minutes.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/calysteon/nudibranch/internal/beaches"
	"github.com/calysteon/nudibranch/internal/species"
)

func main() {
	beachPath := flag.String("beaches", "data/beaches.json", "path to curated beaches.json")
	outPath := flag.String("out", "data/species.json", "output species.json path")
	taxonID := flag.Int("taxon", 47113, "iNaturalist taxon id (47113 = Nudibranchia; verify before trusting)")
	radiusKm := flag.Float64("radius", 8.0, "max distance (km) from a beach to attribute an observation")
	topN := flag.Int("top", 12, "max species to keep per beach per month")
	neLat := flag.Float64("nelat", 49.5, "bounding box north-east latitude")
	neLng := flag.Float64("nelng", -116.5, "bounding box north-east longitude")
	swLat := flag.Float64("swlat", 42.0, "bounding box south-west latitude")
	swLng := flag.Float64("swlng", -125.5, "bounding box south-west longitude")
	flag.Parse()

	set, err := beaches.Load(os.DirFS("."), *beachPath)
	if err != nil {
		log.Fatalf("load beaches: %v", err)
	}
	beachList := set.All()
	if len(beachList) == 0 {
		log.Fatal("no beaches loaded")
	}

	agg := newAggregator(beachList, *radiusKm)

	client := &http.Client{Timeout: 30 * time.Second}
	var idAbove int64
	page := 0
	for {
		obs, maxID, err := fetchPage(client, *taxonID, idAbove, *neLat, *neLng, *swLat, *swLng)
		if err != nil {
			log.Fatalf("fetch page (id_above=%d): %v", idAbove, err)
		}
		if len(obs) == 0 {
			break
		}
		for _, o := range obs {
			agg.add(o)
		}
		page++
		log.Printf("page %d: %d observations (through id %d), %d attributed so far", page, len(obs), maxID, agg.attributed)
		idAbove = maxID
		time.Sleep(1100 * time.Millisecond) // stay well under iNat's rate limit
	}

	out := agg.build(*topN)
	if err := writeJSON(*outPath, out); err != nil {
		log.Fatalf("write %s: %v", *outPath, err)
	}
	log.Printf("wrote %s: %d observations attributed to %d beaches", *outPath, agg.attributed, len(out.Beaches))
}

// --- iNaturalist API ---

type inatObservation struct {
	ID                int64 `json:"id"`
	ObservedOnDetails struct {
		Month int `json:"month"`
	} `json:"observed_on_details"`
	Geojson struct {
		Coordinates []float64 `json:"coordinates"` // [lng, lat]
	} `json:"geojson"`
	Taxon struct {
		ID                  int    `json:"id"`
		Name                string `json:"name"`
		Rank                string `json:"rank"`
		PreferredCommonName string `json:"preferred_common_name"`
	} `json:"taxon"`
}

func fetchPage(c *http.Client, taxonID int, idAbove int64, neLat, neLng, swLat, swLng float64) ([]inatObservation, int64, error) {
	q := url.Values{}
	q.Set("taxon_id", strconv.Itoa(taxonID))
	q.Set("quality_grade", "research") // community-verified, so species IDs are trustworthy
	q.Set("nelat", ftoa(neLat))
	q.Set("nelng", ftoa(neLng))
	q.Set("swlat", ftoa(swLat))
	q.Set("swlng", ftoa(swLng))
	q.Set("per_page", "200")
	q.Set("order_by", "id")
	q.Set("order", "asc")
	q.Set("id_above", strconv.FormatInt(idAbove, 10)) // keyset pagination dodges the 10k cap

	req, _ := http.NewRequest(http.MethodGet, "https://api.inaturalist.org/v1/observations?"+q.Encode(), nil)
	req.Header.Set("User-Agent", "nudibranch-tidepool-planner (https://github.com/calysteon/nudibranch)")
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	var body struct {
		Results []inatObservation `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, 0, err
	}
	var maxID int64
	for _, o := range body.Results {
		if o.ID > maxID {
			maxID = o.ID
		}
	}
	return body.Results, maxID, nil
}

// --- aggregation ---

type taxonTally struct {
	common     string
	scientific string
	taxonID    int
	count      int
	sumLat     float64 // running sum of sighting coords, for a centroid
	sumLon     float64
}

type aggregator struct {
	beaches  []beaches.Beach
	radiusKm float64
	// beachID -> month -> taxonID -> tally
	data       map[string]map[int]map[int]*taxonTally
	attributed int
}

func newAggregator(b []beaches.Beach, radiusKm float64) *aggregator {
	return &aggregator{
		beaches:  b,
		radiusKm: radiusKm,
		data:     map[string]map[int]map[int]*taxonTally{},
	}
}

func (a *aggregator) add(o inatObservation) {
	if o.Taxon.Rank != "species" && o.Taxon.Rank != "subspecies" {
		return // only count observations identified to (at least) species
	}
	if len(o.Geojson.Coordinates) != 2 || o.ObservedOnDetails.Month == 0 {
		return
	}
	lng, lat := o.Geojson.Coordinates[0], o.Geojson.Coordinates[1]

	nearest, best := "", math.MaxFloat64
	for _, b := range a.beaches {
		if d := haversineKm(lat, lng, b.Lat, b.Lon); d < best {
			best, nearest = d, b.ID
		}
	}
	if nearest == "" || best > a.radiusKm {
		return
	}

	month := o.ObservedOnDetails.Month
	if a.data[nearest] == nil {
		a.data[nearest] = map[int]map[int]*taxonTally{}
	}
	if a.data[nearest][month] == nil {
		a.data[nearest][month] = map[int]*taxonTally{}
	}
	t := a.data[nearest][month][o.Taxon.ID]
	if t == nil {
		common := o.Taxon.PreferredCommonName
		if common == "" {
			common = o.Taxon.Name
		}
		t = &taxonTally{common: common, scientific: o.Taxon.Name, taxonID: o.Taxon.ID}
		a.data[nearest][month][o.Taxon.ID] = t
	}
	t.count++
	t.sumLat += lat
	t.sumLon += lng
	a.attributed++
}

type fileFormat struct {
	GeneratedAt string                                  `json:"generatedAt"`
	Beaches     map[string]map[string][]species.Species `json:"beaches"`
}

func (a *aggregator) build(topN int) fileFormat {
	out := fileFormat{
		GeneratedAt: time.Now().UTC().Format("2006-01-02"),
		Beaches:     map[string]map[string][]species.Species{},
	}
	for beachID, byMonth := range a.data {
		out.Beaches[beachID] = map[string][]species.Species{}
		for month, tallies := range byMonth {
			list := make([]species.Species, 0, len(tallies))
			for _, t := range tallies {
				sp := species.Species{
					CommonName: t.common,
					Scientific: t.scientific,
					Count:      t.count,
					TaxonID:    t.taxonID,
				}
				if t.count > 0 {
					sp.Lat = t.sumLat / float64(t.count)
					sp.Lon = t.sumLon / float64(t.count)
				}
				list = append(list, sp)
			}
			sort.Slice(list, func(i, j int) bool { return list[i].Count > list[j].Count })
			if len(list) > topN {
				list = list[:topN]
			}
			out.Beaches[beachID][strconv.Itoa(month)] = list
		}
	}
	return out
}

// --- helpers ---

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371.0
	dLat := rad(lat2 - lat1)
	dLon := rad(lon2 - lon1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Sin(dLon/2)*math.Sin(dLon/2)
	return r * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func rad(d float64) float64 { return d * math.Pi / 180 }

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', 5, 64) }

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
