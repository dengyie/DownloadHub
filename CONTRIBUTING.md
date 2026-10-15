# Contributing to DownloadHub

Thank you for your interest in contributing to **DownloadHub**! We welcome contributions, bug reports, and suggestions from the community.

## Development Workflow

### Prerequisites
- **Go 1.26+**
- **Node.js 22+** (for frontend static building and unit tests)
- **Python 3.10+** (for deployment and boundary test suites)

### Running Tests Locally
Before submitting a pull request, ensure all tests pass:

```bash
# Run unit tests with race detection
go test -race -count=1 ./...

# Verify code style and formatting
go vet ./...
test -z "$(gofmt -l *.go)"

# Run frontend tests
npm --prefix frontend test
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
