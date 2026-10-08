.PHONY: check check-php build-linux
check:
	go vet ./...
	go test -race -count=1 ./...
	node --test web/frontend.test.cjs
	node --test frontend/tests/*.test.mjs
	python3 -m unittest discover -s deploy -p '*_test.py'
	$(MAKE) check-php
	@test -z "$$(gofmt -l *.go)"
	git diff --check

check-php:
	python3 commerce/tests/run.py

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o cardgw-linux-amd64 .
