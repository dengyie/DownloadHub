package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicCatalogRejectsPrivateOrAmbiguousLocations(t *testing.T) {
	valid := publicResource{ID: "tool", Name: "Tool", Description: "A public tool", Category: "tools", Version: "1", Platform: "Linux", Path: "/pub/tool.zip", Filename: "tool.zip", Bytes: 32, UpdatedAt: "2026-10-09", Kind: "binary"}
	for _, location := range []string{"/private/tool.zip", "/pub/../private/tool.zip", "/pub/%2e%2e/private/tool.zip", "/pub//tool.zip", "//evil.test/tool.zip", "https://evil.test/tool.zip", "/pub/tool.zip?token=secret", "/pub/tool.zip#fragment", "/pub\\tool.zip"} {
		t.Run(location, func(t *testing.T) {
			item := valid
			item.Path = location
			data, _ := json.Marshal([]publicResource{item})
			if _, err := parsePublicCatalog(data, []string{"pub/"}); err == nil {
				t.Fatalf("unsafe location accepted: %s", location)
			}
		})
	}
	data, _ := json.Marshal([]publicResource{valid})
	if _, err := parsePublicCatalog(data, []string{"pub/"}); err != nil {
		t.Fatal(err)
	}
	if _, err := parsePublicCatalog(data, []string{"other/"}); err == nil {
		t.Fatal("catalog must match configured public prefixes")
	}
	duplicate, _ := json.Marshal([]publicResource{valid, valid})
	if _, err := parsePublicCatalog(duplicate, []string{"pub/"}); err == nil {
		t.Fatal("duplicate identity accepted")
	}
	if _, err := parsePublicCatalog([]byte(strings.TrimSuffix(string(data), "]")+",{}]"), []string{"pub/"}); err == nil {
		t.Fatal("incomplete resource accepted")
	}
}

func TestBundledCatalogOnlyContainsPublishedPublicResources(t *testing.T) {
	items, err := loadPublicCatalog("", []string{"pub/"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 4 {
		t.Fatalf("expected four curated resources, got %d", len(items))
	}
}
