package main

import _ "embed"

//go:embed brand/favicon-192.png
var brandLogoPNG []byte

//go:embed brand/favicon.ico
var brandFaviconICO []byte

//go:embed brand/apple-touch-icon.png
var brandAppleTouchPNG []byte
