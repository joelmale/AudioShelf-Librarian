# AudioShelf Librarian Project Status

This file replaces the original Python-era setup checklist. AudioShelf Librarian is now a Node.js workspace with a React/Vite frontend, an Express backend, shared TypeScript models, and a GHCR-first release pipeline.

## Current structure

- `apps/frontend/`: sole responsive librarian interface.
- `apps/backend/`: API, WebSocket, scanning, curation, acquisition, and encoding orchestration.
- `packages/shared/`: shared TypeScript types and schemas.
- `scripts/`: release verification, bundle-budget enforcement, and controlled live validation.
- `.github/workflows/ci.yml`: build, bundle, lint, and test gate.
- `.github/workflows/docker-publish.yml`: tested, signed GHCR publication and GitHub Releases.

The retired Python implementation remains under `python_archive/` for historical reference only.

## Development checks

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:bundle
npm run release:check
```

## Releases

The former `scripts/release.sh` and `make release-*` commands have been removed. Releases are created from an explicit semantic-version commit and annotated Git tag:

```bash
npm run release:check -- 1.1.0
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin v1.1.0
```

The tag workflow verifies that the tag matches every workspace version and the lockfile, builds and signs the GHCR image, publishes `vX.Y.Z`, `X.Y.Z`, and `X.Y` aliases, and creates the matching GitHub Release. `latest` remains attached to the newest successful `main` build.

See [.github/GITHUB_SETUP_GUIDE.md](.github/GITHUB_SETUP_GUIDE.md) for the complete release procedure and [docs/controlled-live-validation.md](docs/controlled-live-validation.md) for deployment validation.
