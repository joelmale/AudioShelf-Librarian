# AudioShelf Librarian

Organize and scan audiobook libraries with a CLI and a web UI. This repo provides a local-first tool that can scan folders, track progress, and expose a small web interface for operations.

## Quick Start (Local)
Requirements: Python 3.9+

```bash
pip install -r requirements.txt
python audioshelf-librarian.py web --dev
```

Open `http://localhost:8000` in your browser.

### CLI Example
```bash
python audioshelf-librarian.py cli --help
```

## Common Commands
```bash
make web        # run web UI (dev)
make web-prod   # run web UI (production)
make cli        # show CLI help
make test       # run pytest
make format     # black + isort
make lint       # flake8
```

## Docker Deployment
Use the provided compose file for a simple deployment.

1) Update volume paths in `docker-compose.yml`:
- `/path/to/your/audiobooks`
- `/path/to/your/inbox`
- `./data` and `./logs` (local folders for persistence)

2) Build and run:
```bash
docker-compose up -d
```

Visit `http://localhost:8000`.

## Configuration & Logs
- Logs: `~/.audioshelf_librarian.log`
- Scan progress: `.audioshelf_scan_progress.json` (created in the working directory if enabled)

## Project Layout
- Core library: `audioshelf_librarian/`
- Entrypoints: `audioshelf-librarian.py`, `audioshelf-cli.py`, `audioshelf-server.py`
- Web assets: `templates/`, `static/`
- Tests: `tests/`

## Contributing
See `CONTRIBUTING.md` for development setup and guidelines.
