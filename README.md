# AudioShelf-Librarian & Curator (Unified Monorepo)

A single TypeScript repository that combines the core `AudioShelf-Librarian` file-scanning capabilities with the `abs-curator` AI recommendation engine into one unified Node.js backend and React frontend.

## Project Structure (NPM Workspaces)

- **`apps/backend/`**: Single Node.js server (Express + WebSockets) managing both librarian tasks and AI curation.
- **`apps/frontend/`**: Unified Vite + React Single Page Application (SPA).
- **`packages/shared/`**: Strictly typed shared models (Zod schemas), TS interfaces, and WebSocket payloads.
- **`scripts/`**: Release verification, frontend bundle-budget enforcement, and controlled live validation.

## Getting Started

### Prerequisites
- Node.js 20+
- NPM Workspace support

### Installation
```bash
npm install
```

### Running the App
To start both the frontend and backend in development mode:
```bash
npm run dev
```

### Type Checking & Linting
Ensure strict typing holds across the boundary:
```bash
npm run typecheck
```

## Releases

Releases are cut from an explicit semantic-version commit and annotated Git tag:

```bash
npm run release:check -- 1.1.0
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin v1.1.0
```

The tag workflow verifies that the tag matches every workspace version and the
lockfile, builds and signs the GHCR image, publishes `vX.Y.Z`, `X.Y.Z` and `X.Y`
aliases, and creates the matching GitHub Release. `latest` stays attached to the
newest successful `main` build. See
[.github/GITHUB_SETUP_GUIDE.md](.github/GITHUB_SETUP_GUIDE.md) for the full
procedure.

## Retired Python implementation

The original Python implementation has been removed from the working tree. It is
preserved in git history and reachable from the `archive/python-implementation`
tag:

```bash
git checkout archive/python-implementation -- python_archive/
```

## Documentation

- [Docker deployment](docs/deployment.md) — environment variables, security defaults, MCP server, image tagging strategy
- [Controlled live validation](docs/controlled-live-validation.md) — the disposable-stack mutation sequence and evidence checklist
- [Primary UI architecture](docs/primary-ui.md) — canonical routes, settings behavior, loading architecture
- [Current status](docs/current-status.md) — active milestone and next steps
