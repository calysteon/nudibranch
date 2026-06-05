// Package nudibranch embeds the web assets and default data files so the
// server compiles to a single self-contained binary. This keeps deployment to
// a VPS as simple as copying one file: there is no runtime, node_modules, or
// asset directory to ship alongside it.
package nudibranch

import "embed"

// WebFS holds the HTML templates and static front-end assets.
//
//go:embed web
var WebFS embed.FS

// DataFS holds the default (sample) beach and species datasets. Real
// iNaturalist-derived data can be supplied at runtime via the -data flag,
// which overrides these embedded defaults.
//
//go:embed data
var DataFS embed.FS
