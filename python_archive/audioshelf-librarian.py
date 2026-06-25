#!/usr/bin/env python3
"""
AudioShelf Librarian - Unified Entry Point

A comprehensive audiobook library organization tool with both CLI and web
interfaces. Organizes audiobooks according to AudioBookShelf conventions with
intelligent metadata detection, parallel processing, and real-time progress
tracking.

Usage:
    audioshelf-librarian web --dev
    audioshelf-librarian web --port 3000
    audioshelf-librarian cli scan /books
    audioshelf-librarian cli --help
    audioshelf-librarian version
"""

import platform
import subprocess
import sys
from pathlib import Path
from typing import Optional

import typer


__version__ = "1.0.0"
__author__ = "AudioShelf Librarian Contributors"
__description__ = "Intelligent audiobook library organizer for AudioBookShelf"

app = typer.Typer(
    name="audioshelf-librarian",
    help="AudioShelf Librarian - Intelligent audiobook organization tool",
    no_args_is_help=True,
)

project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))


@app.command()
def web(
    dev: bool = typer.Option(
        False,
        "--dev",
        help="Enable development mode with auto-reload",
    ),
    host: str = typer.Option("0.0.0.0", "--host", help="Host to bind to"),
    port: int = typer.Option(8000, "--port", help="Port to bind to"),
    workers: int = typer.Option(
        1,
        "--workers",
        help="Number of worker processes in production mode",
    ),
    log_level: str = typer.Option(
        "info",
        "--log-level",
        help="Log level: debug, info, warning, or error",
    ),
    test_config: bool = typer.Option(
        False,
        "--test",
        help="Test configuration and exit",
    ),
) -> None:
    """Start the AudioShelf Librarian web interface."""
    args = [sys.executable, str(project_root / "audioshelf-server.py")]

    if test_config:
        args.append("test")
    else:
        args.extend(
            [
                "start",
                "--host",
                host,
                "--port",
                str(port),
                "--workers",
                str(workers),
                "--log-level",
                log_level,
            ]
        )
        if dev:
            args.append("--dev")

    try:
        subprocess.run(args, check=True)
    except subprocess.CalledProcessError as exc:
        typer.echo(f"Error starting web server: {exc}", err=True)
        raise typer.Exit(1) from exc
    except KeyboardInterrupt:
        typer.echo("\nWeb server stopped")
        raise typer.Exit(0)


@app.command()
def cli(
    args: Optional[list[str]] = typer.Argument(
        None,
        help="CLI arguments to pass through",
    )
) -> None:
    """Run the AudioShelf Librarian command-line interface."""
    cli_args = [sys.executable, str(project_root / "audioshelf-cli.py")]
    if args:
        cli_args.extend(args)

    try:
        subprocess.run(cli_args, check=True)
    except subprocess.CalledProcessError as exc:
        typer.echo(f"CLI error: {exc}", err=True)
        raise typer.Exit(1) from exc
    except KeyboardInterrupt:
        typer.echo("\nCLI operation cancelled")
        raise typer.Exit(0)


@app.command()
def version() -> None:
    """Show version information and project details."""
    typer.echo(f"AudioShelf Librarian v{__version__}")
    typer.echo(__description__)
    typer.echo(__author__)
    typer.echo()
    typer.echo("Available interfaces:")
    typer.echo("   - Web Interface: Browser UI with real-time progress")
    typer.echo("   - CLI Interface: Batch operations from the command line")
    typer.echo()
    typer.echo("Quick start:")
    typer.echo("   python audioshelf-librarian.py web --dev")
    typer.echo("   python audioshelf-librarian.py cli --help")


@app.command()
def info() -> None:
    """Show detailed system and configuration information."""
    typer.echo("AudioShelf Librarian System Information")
    typer.echo("=" * 50)
    typer.echo(f"Project root: {project_root}")
    typer.echo(f"Python version: {sys.version.split()[0]}")
    typer.echo(f"Platform: {platform.system()} {platform.release()}")
    typer.echo(f"Architecture: {platform.machine()}")

    typer.echo("\nProject structure:")
    key_files = [
        ("CLI entry point", "audioshelf-cli.py"),
        ("Web server", "audioshelf-server.py"),
        ("Main package", "audioshelf_librarian/"),
        ("Web templates", "templates/"),
        ("Static files", "static/"),
        ("Requirements", "requirements.txt"),
    ]

    for description, path in key_files:
        full_path = project_root / path
        status = "ok" if full_path.exists() else "missing"
        typer.echo(f"   {status}: {description}: {path}")

    typer.echo("\nDependencies:")
    try:
        import fastapi

        typer.echo(f"   ok: FastAPI {fastapi.__version__}")
    except ImportError:
        typer.echo("   missing: FastAPI")

    try:
        import uvicorn

        typer.echo(f"   ok: Uvicorn {uvicorn.__version__}")
    except ImportError:
        typer.echo("   missing: Uvicorn")

    try:
        import mutagen

        typer.echo(f"   ok: Mutagen {mutagen.version_string}")
    except ImportError:
        typer.echo("   missing: Mutagen")

    typer.echo("\nReady to use:")
    typer.echo("   python audioshelf-librarian.py web --dev")
    typer.echo("   python audioshelf-librarian.py cli --help")


if __name__ == "__main__":
    app()
