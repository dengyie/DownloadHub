package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

//go:embed catalog/public.json
var bundledPublicCatalog []byte

type publicResource struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Version     string `json:"version"`
	Platform    string `json:"platform"`
	Path        string `json:"path"`
	Filename    string `json:"filename"`
	Bytes       int64  `json:"bytes"`
	UpdatedAt   string `json:"updated_at"`
	Kind        string `json:"kind"`
	Featured    bool   `json:"featured"`
}

var catalogID = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func loadPublicCatalog(filename string, publicPrefixes []string) ([]publicResource, error) {
	data := bundledPublicCatalog
	if filename != "" {
		file, err := os.Open(filename)
		if err != nil {
			return nil, fmt.Errorf("public catalog cannot be opened")
		}
		defer file.Close()
		data, err = io.ReadAll(io.LimitReader(file, (1<<20)+1))
		if err != nil {
			return nil, fmt.Errorf("public catalog cannot be read")
		}
	}
	return parsePublicCatalog(data, publicPrefixes)
}

func parsePublicCatalog(data []byte, publicPrefixes []string) ([]publicResource, error) {
	if len(data) > 1<<20 {
		return nil, fmt.Errorf("public catalog exceeds 1 MiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var resources []publicResource
	if err := decoder.Decode(&resources); err != nil {
		return nil, fmt.Errorf("public catalog must contain resource records only")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || resources == nil || len(resources) > 500 {
		return nil, fmt.Errorf("invalid public catalog length or trailing data")
	}
	ids, paths := map[string]bool{}, map[string]bool{}
	for _, resource := range resources {
		if !catalogID.MatchString(resource.ID) || len(resource.ID) > 80 || ids[resource.ID] || paths[resource.Path] {
			return nil, fmt.Errorf("public resource identity must be unique")
		}
		ids[resource.ID], paths[resource.Path] = true, true
		if resource.Name == "" || len(resource.Name) > 200 || resource.Description == "" || len(resource.Description) > 2000 || resource.Version == "" || resource.Platform == "" || resource.Bytes <= 0 {
			return nil, fmt.Errorf("incomplete public resource metadata")
		}
		if resource.Category != "tools" && resource.Category != "android" && resource.Category != "scripts" {
			return nil, fmt.Errorf("unknown public resource category")
		}
		if resource.Kind != "binary" && resource.Kind != "app" && resource.Kind != "script" {
			return nil, fmt.Errorf("unknown public resource kind")
		}
		if _, err := time.Parse("2006-01-02", resource.UpdatedAt); err != nil {
			return nil, fmt.Errorf("invalid public resource date")
		}
		location, err := url.Parse(resource.Path)
		if err != nil || location.IsAbs() || location.Host != "" || location.RawQuery != "" || location.Fragment != "" || !strings.HasPrefix(resource.Path, "/") || strings.ContainsAny(resource.Path, "%\\ \t\r\n") {
			return nil, fmt.Errorf("public resource URL must be an unambiguous root-relative file path")
		}
		name := strings.TrimPrefix(resource.Path, "/")
		if validateResourcePath(name) != nil || path.Base(name) != resource.Filename {
			return nil, fmt.Errorf("invalid public resource path or filename")
		}
		allowed := false
		for _, prefix := range publicPrefixes {
			if prefix != "" && strings.HasSuffix(prefix, "/") && strings.HasPrefix(name, prefix) {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("catalog resource is outside configured public directories")
		}
	}
	return resources, nil
}

func (h *handler) handleCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		h.respond(w, 405, map[string]any{"code": 405, "msg": "Method not allowed"})
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if h.catalogErr != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusOK)
		}
		return
	}
	if h.catalogErr != nil {
		h.respond(w, 503, map[string]any{"code": 503, "msg": "公开资源目录暂时不可用"})
		return
	}
	h.respond(w, 200, map[string]any{"code": 200, "resources": h.catalog})
}
