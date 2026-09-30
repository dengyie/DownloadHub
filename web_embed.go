package main

import (
	"crypto/sha256"
	"embed"
	"fmt"
	"strings"
)

//go:embed web/redeem.html
var redeemTemplate string

//go:embed web/redeem.js web/redeem.css
var webAssets embed.FS

var redeemHTML = versionedRedeemHTML()

func versionedRedeemHTML() string {
	html := redeemTemplate
	for _, name := range []string{"redeem.js", "redeem.css"} {
		data, err := webAssets.ReadFile("web/" + name)
		if err != nil {
			panic(err)
		} // go:embed guarantees both application assets exist.
		hash := sha256.Sum256(data)
		path := "/assets/" + name
		html = strings.ReplaceAll(html, path, fmt.Sprintf("%s?v=%x", path, hash[:12]))
	}
	return html
}
