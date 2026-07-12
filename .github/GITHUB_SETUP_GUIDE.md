# GitHub CI, Container, and Release Guide

## Required repository permissions

GitHub Actions must be allowed to read repository contents, write packages, request an OIDC identity token for Cosign, and write releases for semantic-version tags. The repository workflows declare the narrow job permissions they need.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request targeting `main`:

1. install with `npm ci`;
2. build every workspace;
3. enforce the frontend initial-JavaScript budget and lazy boundaries;
4. validate release-version metadata;
5. run any workspace lint scripts; and
6. run all workspace tests.

No fallback converts a failed test into a successful job.

## Container publishing

`.github/workflows/docker-publish.yml` runs for pull requests, pushes to `main`, and `vX.Y.Z` tags. Before publishing it repeats type checking, tests, builds, bundle verification, and release metadata validation.

Main publishes:

- `latest`;
- `main`; and
- `sha-<full-commit-sha>`.

A Git tag such as `v1.1.0` publishes:

- `v1.1.0`;
- `1.1.0`;
- `1.1`; and
- `sha-<full-commit-sha>`.

Published images are signed with keyless Cosign. After the image and signatures succeed, the tag workflow creates a GitHub Release with generated notes.

## Release procedure

1. Choose the next semantic version.
2. Update the root, backend, frontend, shared, and lockfile versions.
3. Add the dated changelog entry.
4. Run:

   ```bash
   npm run typecheck
   npm test
   npm run build
   npm run verify:bundle
   npm run release:check -- 1.1.0
   ```

5. Push the release commit to `main` and require both CI and Docker Publish to succeed.
6. Create and push the annotated tag:

   ```bash
   git tag -a v1.1.0 -m "Release v1.1.0"
   git push origin v1.1.0
   ```

7. Require the tag-triggered Docker Publish run to succeed.
8. Verify the immutable image before updating production:

   ```bash
   docker manifest inspect ghcr.io/joelmale/audioshelf-librarian:v1.1.0
   docker pull ghcr.io/joelmale/audioshelf-librarian:v1.1.0
   ```

9. Run the read-only and plan-only checks in `docs/controlled-live-validation.md`.

Never create or move a stable tag when any gate is failing. Fix the release commit and use a new semantic version if an already-published tag is defective.
