package main

import (
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

var frontendDocument = regexp.MustCompile(`^(?:/(?:redeem|help|orders)?/?|/resources/[a-z0-9-]+|/item/[1-9][0-9]*|/cat/(?:[0-9]+|recommend)|/user/index/(?:index|item|query)|/user/authentication/(?:login|register|emailForget|phoneForget)|/user/dashboard/index)$`)
var frontendAsset = regexp.MustCompile(`^/ui/[a-f0-9]{24}/[A-Za-z0-9_/-]+\.(?:js|css)$`)
var frontendBrand = regexp.MustCompile(`^/brand/(?:logo\.png|favicon\.ico|apple-touch-icon\.png)$`)

// A frontend artifact is independently built and deployed. The gateway does not
// inject business data, secrets, or per-request script into its document shell.
func newFrontendHandler(root fs.FS) http.Handler {
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := r.URL.Path
		if strings.ContainsAny(name, "\\\x00") || strings.Contains(name, "//") || path.Clean(name) != name && name != "/" {
			http.NotFound(w, r)
			return
		}
		if frontendAsset.MatchString(name) || frontendBrand.MatchString(name) {
			info, err := fs.Stat(root, strings.TrimPrefix(name, "/"))
			if err != nil || !info.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			if frontendAsset.MatchString(name) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=86400")
			}
			files.ServeHTTP(w, r)
			return
		}
		legacy := strings.HasPrefix(name, "/dl/") && validateResourcePath(strings.TrimPrefix(name, "/dl/")) == nil
		if !frontendDocument.MatchString(name) && !legacy {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(root, "index.html")
		if err != nil {
			http.Error(w, "frontend unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == http.MethodGet {
			w.Write(data)
		}
	})
}
