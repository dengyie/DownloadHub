.PHONY: check check-frontend check-browser check-php build build-linux
check:
	go vet ./...
	go test -race -count=1 ./...
	python3 -m unittest discover -s deploy -p '*_test.py'
	$(MAKE) check-frontend
	$(MAKE) check-browser
	$(MAKE) check-php
	@test -z "$$(gofmt -l *.go)"
	git diff --check

build:
	go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o opencardgate .

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o opencardgate-linux-amd64 .
