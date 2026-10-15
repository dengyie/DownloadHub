# Contributing to DownloadHub

Thank you for your interest in contributing to **DownloadHub**! We welcome contributions, bug reports, and suggestions from the community.

## Development Workflow

### Prerequisites
- **Go 1.26+**
- **Node.js 22+** (for frontend static building and unit tests)
- **Python 3.10+** (for deployment and boundary test suites)
- **PHP 8.2** with `bcmath`, `pdo_sqlite`, `sqlite3`, `mbstring`, `curl`, `gd`, `zip`, `openssl` (for the commerce suite; a missing runtime fails `make check` instead of skipping it)
- **nginx** (optional; the isolated routing acceptance tests skip automatically when it is absent)
- **Playwright Chromium** (`npx --prefix frontend playwright install chromium`) for browser tests

### Running Tests Locally
Before submitting a pull request, ensure all tests pass:

```bash
# Run the complete quality gate (same as CI)
make check

# Or run individual suites:
go test -race -count=1 ./...       # Go unit tests with race detection
go vet ./... && test -z "$(gofmt -l *.go)"   # Go style and formatting
npm --prefix frontend test         # frontend unit tests
npm --prefix frontend run format:check
npm --prefix frontend run build
```

### Commit Guidelines
We use concise and structured commit messages following conventional commits:
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding or correcting tests

---

## Code of Conduct

Be respectful, considerate, and collaborative. All discussions and contributions should maintain a welcoming environment for everyone.
