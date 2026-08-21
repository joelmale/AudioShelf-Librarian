# Contributing to AudioShelf Librarian

Thank you for considering contributing to AudioShelf Librarian! This document provides guidelines and information for contributors.

## 🎯 Ways to Contribute

### 🐛 Bug Reports
- Use the GitHub issue tracker
- Include detailed reproduction steps
- Provide system information (OS, Node version, deployment method)
- Include relevant log output — scrub any tokens or proxy URLs first

### 💡 Feature Requests
- Check existing issues first
- Describe the use case clearly
- Explain how it would improve the user experience
- Consider implementation complexity

### 📝 Code Contributions
- Fork the repository
- Create a feature branch
- Write comprehensive tests
- Follow coding standards
- Update documentation

### 📚 Documentation
- Improve README clarity
- Add usage examples
- Update API documentation
- Fix typos and grammar

## 🔧 Development Setup

### Prerequisites
- Node.js 24 or higher
- Git
- A build toolchain for native modules (`better-sqlite3` compiles via node-gyp:
  Python 3, `make`, and a C++ compiler — already present in the Docker build)

### Local Development
```bash
# Clone your fork
git clone https://github.com/yourusername/AudioShelf-Librarian.git
cd AudioShelf-Librarian

# Install all workspaces
npm ci

# Start backend and frontend together
npm run dev

# Verify everything before committing
npm run typecheck
npm run lint
npm test
```

The backend listens on `3050`; the Vite dev server proxies `/api` to it.

## 📋 Coding Standards

### TypeScript Style
- `strict: true` everywhere — do not weaken it locally
- Prefer explicit types at module boundaries; inference inside functions is fine
- Validate anything crossing a trust boundary (HTTP bodies, WebSocket payloads,
  external API responses) with a Zod schema, not a type assertion

### Linting
```bash
npm run lint        # flat config at the repo root, covers every workspace
npm run lint:fix    # autofix what can be autofixed
```

Rules that catch real defects are errors. The pre-existing `any`, unused-symbol,
and React hook-dependency debt is reported as warnings so the baseline is
visible; please do not add to it. There is no formatter configured — match the
style of the surrounding file.

### Naming Conventions
- **Functions / variables**: `camelCase`
- **Types / classes / components**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Files**: `camelCase.ts`, `PascalCase.tsx` for components

## 🧪 Testing

Vitest, with tests colocated next to the code they cover.

```bash
npm test                        # every workspace
npm test -w @audioshelf/backend # one workspace
npx vitest run src/security     # one directory
npx vitest watch                # watch mode (from within a workspace)
```

### Writing Tests
- Name files `*.test.ts` / `*.test.tsx` beside the module under test
- Test failure paths, not just the happy path
- Filesystem tests must use an `fs.mkdtempSync(os.tmpdir())` sandbox and clean
  up in `afterEach`. Never touch a real library or inbox path
- No network access. Inject dependencies instead — `llmClient.ts`'s
  `MessageCreator` is the established pattern for this
- Anything that moves, renames, or deletes files **requires** a failure-path
  test. `rollback.test.ts` and `organizer.test.ts` are the reference cases

## 🏗️ Architecture Guidelines

### Core Principles
- **Separation of concerns** — routes are thin; logic lives in `core/` or
  `services/` where it can be tested without an HTTP server
- **Data safety first** — this application moves and deletes real user media
- **Graceful degradation** — an unreachable ABS, qBittorrent, or LLM provider
  should degrade the feature, not fail the request
- **Cross-platform** — development happens on Windows and Linux; production is
  Linux in Docker

### Module Organization
```
apps/backend/src/
├── modules/librarian/    # scanning, organizing, acquisition, ingest jobs
├── modules/curator/      # SQLite mirror, tagging, collections, encoding, MCP
├── modules/system/       # settings and filesystem browsing routes
├── security/             # auth (OIDC), path containment, log redaction
├── config/               # settings store, secret store, history
└── websocket/            # broadcast router

apps/frontend/src/
├── preview/              # the live UI shell, pages, and settings dialog
├── features/             # librarian + curator component trees
└── contexts/             # WebSocket provider

packages/shared/src/      # Zod schemas and types shared across the boundary
```

### Safety Rules
These are not style preferences — breaking them can destroy a user's library or
leak their credentials.

- Every filesystem write goes through `security/paths.ts` containment helpers.
  Validate the **destination**, not just the source
- Never interpolate a secret into a log line. `index.ts` buffers all console
  output into `GET /api/system/logs` and broadcasts it over the WebSocket;
  `security/redact.ts` is a backstop, not permission
- SQLite migrations run at startup against a mounted volume — assume every
  schema change ships straight to a live database with no manual step
- Auth is off by default. Do not assume a request is authenticated

## 🚀 Pull Request Process

### Before Submitting
1. **Fork** the repository
2. **Create** a feature branch from `main`
3. **Implement** your changes
4. **Write or update** tests
5. **Update** documentation
6. **Run** `npm run typecheck`, `npm run lint`, and `npm test`
7. **Commit** with clear messages

### PR Guidelines
- **Title**: Clear, concise description
- **Description**: Explain what and why
- **Link Issues**: Reference related issues
- **Screenshots**: For UI changes
- **Breaking Changes**: Highlight any breaking changes, including settings and
  environment variables

CI runs typecheck, build, frontend bundle budget, release metadata consistency,
lint, and the full test suite. All must pass.

### Review Process
1. Automated tests must pass
2. Code review by maintainers
3. Address feedback promptly
4. Squash commits before merge

## 📚 Documentation

### Code Documentation
- Comment *why*, not *what* — especially for non-obvious safety constraints
- Document the failure modes a function can produce
- Note anything discovered the hard way about an external service in `AGENTS.md`

### Example
```typescript
/**
 * Undo a committed batch of organization actions.
 *
 * Rolling back is idempotent: an action whose file is no longer at the target is
 * reported as already-reverted rather than failed, so retrying a partially
 * applied rollback re-attempts only what is still outstanding.
 *
 * @returns A summary whose `complete` flag is true only when nothing failed —
 *          the caller must not discard the history entry otherwise.
 */
export async function rollbackBatch(
  actions: OrganizationAction[],
  options: RollbackOptions,
): Promise<RollbackSummary>
```

## 🔍 Code Review Guidelines

### For Reviewers
- Be constructive and respectful
- Focus on code quality and maintainability
- Test the changes locally when possible
- Provide specific, actionable feedback
- Scrutinize anything touching file mutation, path handling, or secrets

### For Contributors
- Respond to feedback promptly
- Ask questions if feedback is unclear
- Make requested changes in separate commits
- Update tests and documentation as needed

## 🎉 Recognition

Contributors are recognized in several ways:
- Listed in the README contributors section
- Mentioned in release notes
- GitHub contributor statistics
- Special recognition for significant contributions

## 📧 Questions?

If you have questions about contributing:
- Open an issue for general questions
- Join discussions in existing issues
- Check the README for common questions

Thank you for helping make AudioShelf Librarian better! 🎧
