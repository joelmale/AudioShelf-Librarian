#!/usr/bin/env python3
"""
AudioShelf Librarian - Unified Entry Point

A comprehensive audiobook library organization tool with both CLI and web interfaces.
Organizes audiobooks according to AudioBookShelf conventions with intelligent
metadata detection, parallel processing, and real-time progress tracking.

Usage:
    audioshelf-librarian web --dev          # Start web interface (development)
    audioshelf-librarian web --port 3000    # Start web interface (production)
    audioshelf-librarian cli scan /books    # Use CLI to scan directories
    audioshelf-librarian cli --help         # Show CLI help
    audioshelf-librarian --version          # Show version info
"""

import sys
import subprocess
from pathlib import Path
import typer
from typing import Optional

# Project metadata
__version__ = "1.0.0"
__author__ = "AudioShelf Librarian Contributors"
__description__ = "Intelligent audiobook library organizer for AudioBookShelf"

app = typer.Typer(
    name="audioshelf-librarian",
    help="AudioShelf Librarian - Intelligent audiobook organization tool",
    no_args_is_help=True
)

# Add the project directory to Python path for proper imports
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

@app.command()
def web(
    dev: bool = typer.Option(False, "--dev", help="Enable development mode with auto-reload"),
    host: str = typer.Option("0.0.0.0", "--host", help="Host to bind to"),
    port: int = typer.Option(8000, "--port", help="Port to bind to"),
    workers: int = typer.Option(1, "--workers", help="Number of worker processes (production only)"),
    log_level: str = typer.Option("info", "--log-level", help="Log level (debug, info, warning, error)"),
    test_config: bool = typer.Option(False, "--test", help="Test configuration and exit")
):
    \"\"\"\n    Start the AudioShelf Librarian web interface.\n    \n    The web interface provides a modern, browser-based way to organize your\n    audiobook library with real-time progress tracking, directory browsing,\n    and interactive controls.\n    \n    Examples:\n        audioshelf-librarian web --dev          # Development mode with auto-reload\n        audioshelf-librarian web --port 3000    # Production on port 3000\n        audioshelf-librarian web --workers 4    # Production with 4 workers\n        audioshelf-librarian web --test         # Test configuration\n    \"\"\"\n    \n    # Import and run the web server\n    args = [sys.executable, str(project_root / \"audioshelf-server.py\")]\n    \n    if test_config:\n        args.append(\"test\")\n    else:\n        args.extend([\"start\", \"--host\", host, \"--port\", str(port), \"--workers\", str(workers), \"--log-level\", log_level])\n        if dev:\n            args.append(\"--dev\")\n    \n    try:\n        subprocess.run(args, check=True)\n    except subprocess.CalledProcessError as e:\n        typer.echo(f\"❌ Error starting web server: {e}\", err=True)\n        raise typer.Exit(1)\n    except KeyboardInterrupt:\n        typer.echo(\"\\n👋 Web server stopped\")\n        raise typer.Exit(0)\n\n@app.command()\ndef cli(\n    args: Optional[list[str]] = typer.Argument(None, help=\"CLI arguments to pass through\")\n):\n    \"\"\"\n    Run the AudioShelf Librarian command-line interface.\n    \n    The CLI provides powerful batch processing capabilities with advanced\n    scanning strategies, parallel processing, and detailed progress reporting.\n    \n    Examples:\n        audioshelf-librarian cli scan /audiobooks\n        audioshelf-librarian cli organize /audiobooks/inbox\n        audioshelf-librarian cli benchmark /large-library\n        audioshelf-librarian cli --help\n    \"\"\"\n    \n    # Import and run the CLI\n    cli_args = [sys.executable, str(project_root / \"audioshelf-cli.py\")]\n    if args:\n        cli_args.extend(args)\n    \n    try:\n        subprocess.run(cli_args, check=True)\n    except subprocess.CalledProcessError as e:\n        typer.echo(f\"❌ CLI error: {e}\", err=True)\n        raise typer.Exit(1)\n    except KeyboardInterrupt:\n        typer.echo(\"\\n👋 CLI operation cancelled\")\n        raise typer.Exit(0)\n\n@app.command()\ndef version():\n    \"\"\"Show version information and project details.\"\"\"\n    typer.echo(f\"🎧 AudioShelf Librarian v{__version__}\")\n    typer.echo(f\"📝 {__description__}\")\n    typer.echo(f\"👥 {__author__}\")\n    typer.echo()\n    typer.echo(\"🚀 Available interfaces:\")\n    typer.echo(\"   • Web Interface: Modern browser-based UI with real-time progress\")\n    typer.echo(\"   • CLI Interface: Powerful command-line tools for batch operations\")\n    typer.echo()\n    typer.echo(\"📚 Features:\")\n    typer.echo(\"   • AudioBookShelf-compliant organization\")\n    typer.echo(\"   • Intelligent metadata detection and extraction\")\n    typer.echo(\"   • Parallel processing for large libraries\")\n    typer.echo(\"   • Multiple scanning strategies and resume capability\")\n    typer.echo(\"   • Real-time progress tracking and cancellation\")\n    typer.echo(\"   • Directory browsing and path selection\")\n    typer.echo()\n    typer.echo(\"🔗 Quick start:\")\n    typer.echo(\"   audioshelf-librarian web --dev    # Start web interface\")\n    typer.echo(\"   audioshelf-librarian cli --help   # Show CLI help\")\n\n@app.command()\ndef info():\n    \"\"\"Show detailed system and configuration information.\"\"\"\n    import platform\n    import sys\n    from pathlib import Path\n    \n    typer.echo(\"🔍 AudioShelf Librarian System Information\")\n    typer.echo(\"=\" * 50)\n    \n    # System info\n    typer.echo(f\"📍 Project root: {project_root}\")\n    typer.echo(f\"🐍 Python version: {sys.version.split()[0]}\")\n    typer.echo(f\"💻 Platform: {platform.system()} {platform.release()}\")\n    typer.echo(f\"🏗️  Architecture: {platform.machine()}\")\n    \n    # Project structure\n    typer.echo(\"\\n📁 Project structure:\")\n    key_files = [\n        (\"CLI entry point\", \"audioshelf-cli.py\"),\n        (\"Web server\", \"audioshelf-server.py\"),\n        (\"Main package\", \"audioshelf_librarian/\"),\n        (\"Web templates\", \"templates/\"),\n        (\"Static files\", \"static/\"),\n        (\"Requirements\", \"requirements.txt\")\n    ]\n    \n    for desc, path in key_files:\n        full_path = project_root / path\n        status = \"✅\" if full_path.exists() else \"❌\"\n        typer.echo(f\"   {status} {desc}: {path}\")\n    \n    # Dependencies check\n    typer.echo(\"\\n📦 Dependencies:\")\n    try:\n        import fastapi\n        typer.echo(f\"   ✅ FastAPI: {fastapi.__version__}\")\n    except ImportError:\n        typer.echo(\"   ❌ FastAPI: Not installed\")\n    \n    try:\n        import uvicorn\n        typer.echo(f\"   ✅ Uvicorn: {uvicorn.__version__}\")\n    except ImportError:\n        typer.echo(\"   ❌ Uvicorn: Not installed\")\n    \n    try:\n        import mutagen\n        typer.echo(f\"   ✅ Mutagen: {mutagen.version_string}\")\n    except ImportError:\n        typer.echo(\"   ❌ Mutagen: Not installed\")\n    \n    typer.echo(\"\\n🚀 Ready to use! Try:\")\n    typer.echo(\"   audioshelf-librarian web --dev\")\n    typer.echo(\"   audioshelf-librarian cli --help\")\n\nif __name__ == \"__main__\":\n    app()\n