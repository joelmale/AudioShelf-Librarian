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

## Docker Deployment

The application is deployed using a Docker container, published automatically to the GitHub Container Registry (`ghcr.io`).

### Environment Variables

When configuring the container in your `docker-compose.yml` or Dockhand stack, use the following environment variables:

| Variable | Requirement | Default | Description |
|----------|-------------|---------|-------------|
| `PORT` | Optional | `3050` | The port the Node.js backend listens on. |
| `INBOX_DIR` | Optional | `/library` | The directory the Librarian scans for unorganized audiobooks. |
| `LIBRARY_DIR` | Optional | `/library` | The target directory where the Librarian moves organized audiobooks. |
| `ABS_URL` | Optional* | None | The URL of your Audiobookshelf server (e.g. `https://abs.example.com`). *Required for Active Library Polling.* |
| `ABS_TOKEN` | Optional* | None | Your Audiobookshelf API token. *Required for Active Library Polling.* |
| `QBITTORRENT_URL` | Optional | None | URL of your qBittorrent WebUI instance for automated downloading. |
| `ANTHROPIC_API_KEY` | Optional | None | API key required to enable the ABS Curator AI features. |

### Container Image Tagging Strategy

We use GitHub Actions to automatically build and push Docker images. We follow standard Docker tagging best practices to ensure deployment stability:

- **`latest`**: Points to the most recent commit on the `main` branch. Good for dev/testing, but **not recommended** for production as it may introduce breaking changes.
- **`sha-<commit-hash>`** (e.g., `sha-b1a9ee8`): Created on every push to `main`. This is the exact immutable image built from that specific commit. **Recommended** for predictable deployments and easy rollbacks.
- **`vX.Y.Z`** (e.g., `v1.0.0`): Semantic version tags created when a GitHub Release is published. **Highly Recommended** for stable production deployments.

**Example Production Configuration:**
```yaml
services:
  audioshelf-librarian:
    image: ghcr.io/joelmale/audioshelf-librarian:v1.0.0 # Pin to a stable release
    # ...
```
