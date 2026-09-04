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

## Documentation

- [Docker deployment](docs/deployment.md) — environment variables, security defaults, MCP server, image tagging strategy
- [Controlled live validation](docs/controlled-live-validation.md) — the disposable-stack mutation sequence and evidence checklist
- [Primary UI architecture](docs/primary-ui.md) — canonical routes, settings behavior, loading architecture
- [Current status](docs/current-status.md) — active milestone and next steps
