#!/usr/bin/env python3
"""
Main entry point for AudioShelf Librarian.

This script allows the application to be run directly from the command line
or imported as a module. It provides the CLI interface for organizing
audiobook libraries according to AudioBookShelf conventions.
"""

import sys
from pathlib import Path

# Add the project directory to Python path for proper imports
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from audioshelf_librarian.main import cli_app

if __name__ == "__main__":
    cli_app()
