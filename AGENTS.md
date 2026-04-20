# Repository Guidelines

## Project Structure & Module Organization
- Core library lives in `audioshelf_librarian/` (scanner, organizer, web app, models).
- Entrypoints and utilities are at repo root: `audioshelf-librarian.py`, `audioshelf-cli.py`, `audioshelf-server.py`.
- Web UI assets are in `templates/` and `static/`.
- Tests are in `tests/` (pytest-based; see `tests/TESTING_GUIDE.md` for scenarios).
- Scripts for releases live in `scripts/`.

## Build, Test, and Development Commands
- Install deps: `pip install -r requirements.txt`
- Dev deps: `make dev` (adds pytest, black, isort, flake8)
- Run web (dev): `make web` or `python audioshelf-librarian.py web --dev`
- Run CLI help: `make cli` or `python audioshelf-librarian.py cli --help`
- Run tests: `make test` (alias for `pytest tests/`)
- Coverage: `make test-cov` (writes `htmlcov/`)
- Lint/format: `make lint`, `make format`
- Build dist: `make build` (sdist + wheel)
- Docker: `make docker` / `make docker-run`

## Coding Style & Naming Conventions
- Python 3.9+; follow PEP 8 and keep line length at 88 (Black default).
- Naming: functions/variables `snake_case`, classes `PascalCase`, constants `UPPER_SNAKE_CASE`, files `snake_case.py`.
- Formatting: `black audioshelf_librarian/ *.py` and `isort audioshelf_librarian/ *.py`.
- Linting: `flake8 audioshelf_librarian/` and `flake8 *.py --exclude=venv`.

## Testing Guidelines
- Framework: `pytest` (plus `pytest-asyncio` and `httpx`).
- Conventions: tests live in `tests/` and use `test_*.py` filenames.
- Run specific tests: `pytest tests/test_web.py`
- Coverage target: aim for >90% per `CONTRIBUTING.md`.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and sentence case (e.g., `Add CI/CD setup guide`).
- PRs should include a clear title/description, linked issues, and screenshots for UI changes.
- Before opening a PR: run `make format`, `make lint`, and `make test`.

## Configuration & Data Notes
- Logs are written to `~/.audioshelf_librarian.log`.
- Scan progress may be saved to `.audioshelf_scan_progress.json` in the working directory.
