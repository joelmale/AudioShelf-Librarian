# Changelog

All notable changes to AudioShelf Librarian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-07-12

### Added

- Premium responsive librarian interface for Desk, Scout & Acquire, Curate, Process, Activity, and compact autosaving Settings.
- Settings revision history retaining the latest 100 non-secret states with reversible restores.
- Plan-only-by-default directory scans, server-enforced mutation locks, correlated progress evidence, and controlled live-validation scripts.
- Release checks, frontend bundle budgets, signed GHCR semantic-version aliases, and generated GitHub Releases.

### Changed

- Promoted the redesigned interface to the sole application UI with canonical routes that no longer use `/preview`.
- Deferred Scout, Process, Curate, Activity, Settings, and analytics code until the corresponding workflow is opened.
- Strengthened CI and container publishing so type, test, build, bundle-budget, and release-metadata failures block publication.
- Updated the application and all workspaces to version 1.1.0.

### Removed

- Removed the retained classic React shell, classic-only pages, rollback link, and classic UI bundle.

### Fixed

- Preserved former `/preview/*`, `/classic/*`, `/curator/*`, `/logs/*`, and `/status` bookmarks through canonical redirects.
- Published both `v1.1.0` and `1.1.0` GHCR aliases from a `v1.1.0` Git tag.

## [1.0.0] - 2024-12-19

### Added
- **Web Interface** with modern glassmorphism design
  - Real-time progress tracking via WebSocket
  - Interactive directory browser with file system navigation
  - Operation management (start, monitor, cancel, view results)
  - Mobile-responsive design
  - Live cancellation support

- **Command Line Interface** with comprehensive features
  - Parallel processing with configurable worker threads
  - Advanced scanning strategies (alphabetical, size-based, random, etc.)
  - Progress persistence and resume capability
  - Benchmark tools for performance analysis
  - Flexible configuration options

- **Core Organization Engine**
  - AudioBookShelf-compliant directory structure
  - Multi-source metadata detection (ABS JSON, ID3 tags, filename parsing)
  - Intelligent series detection and numbering
  - Author name normalization
  - Conflict resolution system

- **Performance Features**
  - Concurrent directory scanning
  - Real-time progress tracking with ETA
  - Error recovery and graceful degradation
  - Cross-platform compatibility (Windows, macOS, Linux)

- **Distribution & Development**
  - Unified entry point script (`audioshelf-librarian.py`)
  - Separate CLI and server entry points
  - Comprehensive setup.py for distribution
  - Docker deployment support
  - Development and production modes

### Technical Details
- Built with FastAPI for web interface
- Uses Typer for CLI framework
- Mutagen for audio metadata extraction
- WebSocket support for real-time updates
- SQLite for future transaction logging
- Jinja2 templates for web UI
- Tailwind CSS for responsive design

### Security
- Path validation and sanitization
- Permission error handling
- Secure directory browsing
- Input validation and error boundaries
