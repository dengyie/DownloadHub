package main

import "embed"

//go:embed web/redeem.html
var redeemHTML string

//go:embed web/redeem.js web/redeem.css
var webAssets embed.FS
