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

> [!NOTE]
> UI v2 is the default interface. Use the gear in the upper-right for autosaving settings and the previous 100 non-secret states. The retained classic interface is available from that panel at `/classic` until its removal is explicitly approved. Newly started Librarian operations read the latest values; Curator connection/provider clients that are constructed at startup pick up those particular changes after a service restart.

### Security and integration defaults

The supplied Compose service publishes no host port; attach a trusted reverse proxy to `homelab-net`. Authentication, ABS webhooks, sockets, and automatic ABS writes are disabled by default. Secrets entered in the UI are stored separately in `/app/data/secrets.json` with restrictive permissions and are never returned by the settings API or included in rollback snapshots. Non-secret settings history is stored in `/app/data/settings-history.json`, is capped at 100 states, and should be included with `/app/data` backups. Environment secrets (`ABS_TOKEN`, `ANTHROPIC_API_KEY`, `QBIT_PASS`) override stored values without being persisted.

For Nginx Proxy Manager, use `http` as the forwarding scheme, `audioshelf-librarian` as the forwarding hostname, and `3050` as the forwarding port. Enable **Websockets Support** on the proxy host; HTTPS clients connect to the application over `wss://` and NPM forwards that upgraded connection to the container. Leave asset caching disabled while troubleshooting so a newly published frontend bundle is not masked by an older cached script.

To enable shared OIDC set `AUTH_ENABLED=true`, `OIDC_ISSUER`, and `OIDC_AUDIENCE`. The default group mappings are `audioshelf-viewer`, `audioshelf-curator`, `audioshelf-librarian`, and `audioshelf-admin`. The reverse proxy must forward the `Authorization: Bearer` header. Back up `/app/data` before upgrades; SQLite migrations run transactionally at startup.

The inbox and audiobook library should be on the same filesystem for atomic finalization. The inbox and library mounts require write access only when organization is enabled. Interrupted work is retained in the application data directory for recovery; never delete `/app/data` during a rollback.

### Container Image Tagging Strategy

We use GitHub Actions to automatically build and push Docker images. We follow standard Docker tagging best practices to ensure deployment stability:

- **`latest`**: Points to the most recent commit on the `main` branch. Good for dev/testing, but **not recommended** for production as it may introduce breaking changes.
- **`sha-<commit-hash>`** (e.g., `sha-b1a9ee8`): Created on every push to `main`. This is the exact immutable image built from that specific commit. **Recommended** for predictable deployments and easy rollbacks.
- **`vX.Y.Z`** (for example, `v1.0.0`): Semantic version tags created only after the matching Git tag is pushed. Pin one for stable production deployments after that release exists in GHCR.

**Example Production Configuration:**
```yaml
services:
  audioshelf-librarian:
    image: ${AUDIOSHELF_IMAGE:-ghcr.io/joelmale/audioshelf-librarian:latest}
    # ...
```
