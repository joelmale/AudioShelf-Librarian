# AudioShelf-Librarian & Curator (Unified Monorepo)

A single TypeScript repository that combines the core `AudioShelf-Librarian` file-scanning capabilities with the `abs-curator` AI recommendation engine into one unified Node.js backend and React frontend.

## Project Structure (NPM Workspaces)

- **`apps/backend/`**: Single Node.js server (Express + WebSockets) managing both librarian tasks and AI curation.
- **`apps/frontend/`**: Unified Vite + React Single Page Application (SPA).
- **`packages/shared/`**: Strictly typed shared models (Zod schemas), TS interfaces, and WebSocket payloads.
- **`python_archive/`**: Contains the deprecated Python version of the librarian logic, kept temporarily for reference during the porting process.

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
