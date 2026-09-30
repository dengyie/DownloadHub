.PHONY: check build-linux
check:
	go vet ./...
	go test -race -count=1 ./...
	node --test web/frontend.test.cjs
	python3 -m unittest discover -s deploy -p '*_test.py'
	@test -z "$$(gofmt -l *.go)"
	git diff --check

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=$$(git describe --always --dirty)" -o cardgw-linux-amd64 .
