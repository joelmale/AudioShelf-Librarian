#!/usr/bin/env python3
"""Tests for the project structure and import surface."""

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def test_expected_project_files_exist():
    expected_files = [
        "audioshelf-librarian.py",
        "audioshelf-cli.py",
        "audioshelf-server.py",
        "setup.py",
        "requirements.txt",
        "README.md",
        "LICENSE",
        "Dockerfile",
        "docker-compose.yml",
        "Makefile",
        ".gitignore",
    ]

    for filename in expected_files:
        assert (PROJECT_ROOT / filename).exists(), f"Missing {filename}"


def test_expected_project_directories_exist():
    expected_dirs = [
        "audioshelf_librarian",
        "templates",
        "static",
    ]

    for dirname in expected_dirs:
        assert (PROJECT_ROOT / dirname).is_dir(), f"Missing directory {dirname}"


def test_core_imports_work():
    import audioshelf_librarian
    from audioshelf_librarian.models import Configuration
    from audioshelf_librarian.web_app import app

    assert audioshelf_librarian is not None
    assert Configuration is not None
    assert app.title == "AudioShelf Librarian"
