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

check-frontend:
	npm --prefix frontend test
	npm --prefix frontend run format:check
	npm --prefix frontend run build

check-browser:
	npm --prefix frontend run test:browser

check-php:
	python3 commerce/tests/run.py

build:
	go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o downloadhub .

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o downloadhub-linux-amd64 .
