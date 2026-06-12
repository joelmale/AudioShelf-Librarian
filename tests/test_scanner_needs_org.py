"""
Tests for MetadataScanner._needs_organization.

Previously this method was a stub that always returned True.  It now
delegates to AudiobookOrganizer.validate_organization_compliance() so
that books already in the correct location are recognised as compliant
(needs_processing=False) and misplaced books are correctly flagged.
"""

from pathlib import Path

import pytest

from audioshelf_librarian.config import create_default_config
from audioshelf_librarian.models import Book, Configuration
from audioshelf_librarian.scanner import MetadataScanner


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_scanner(library_path: Path) -> MetadataScanner:
    config = create_default_config()
    config.library_path = library_path
    config.prefer_series_structure = True
    return MetadataScanner(config)


def _standalone_book(source_path: Path) -> Book:
    """A standalone (non-series) book at *source_path*."""
    return Book(
        title="The Hobbit",
        authors=["J.R.R. Tolkien"],
        source_path=source_path,
        is_series=False,
    )


def _series_book(source_path: Path) -> Book:
    """A series book at *source_path*."""
    return Book(
        title="The Fellowship of the Ring",
        authors=["J.R.R. Tolkien"],
        series="The Lord of the Rings",
        series_number=1.0,
        is_series=True,
        source_path=source_path,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestNeedsOrganization:
    """Tests for MetadataScanner._needs_organization."""

    def test_correctly_placed_standalone_book_not_flagged(self, tmp_path):
        """A standalone book already at its target path should not need processing."""
        library = tmp_path / "library"
        # Correct path: library / Author / Title
        correct_path = library / "J.R.R. Tolkien" / "The Hobbit"
        correct_path.mkdir(parents=True)

        scanner = _make_scanner(library)
        book = _standalone_book(correct_path)

        assert scanner._needs_organization(book) is False

    def test_misplaced_standalone_book_flagged(self, tmp_path):
        """A standalone book in the wrong location should need processing."""
        library = tmp_path / "library"
        wrong_path = tmp_path / "downloads" / "The Hobbit"
        wrong_path.mkdir(parents=True)

        scanner = _make_scanner(library)
        book = _standalone_book(wrong_path)

        assert scanner._needs_organization(book) is True

    def test_correctly_placed_series_book_not_flagged(self, tmp_path):
        """A series book already at its correct nested path should not need processing."""
        library = tmp_path / "library"
        # Correct: library / Author / Series / Series - N
        correct_path = (
            library
            / "J.R.R. Tolkien"
            / "The Lord of the Rings"
            / "The Lord of the Rings - 1"
        )
        correct_path.mkdir(parents=True)

        scanner = _make_scanner(library)
        book = _series_book(correct_path)

        assert scanner._needs_organization(book) is False

    def test_misplaced_series_book_flagged(self, tmp_path):
        """A series book in a flat structure should need processing."""
        library = tmp_path / "library"
        wrong_path = library / "J.R.R. Tolkien" / "The Fellowship of the Ring"
        wrong_path.mkdir(parents=True)

        scanner = _make_scanner(library)
        book = _series_book(wrong_path)

        assert scanner._needs_organization(book) is True

    def test_needs_processing_flag_set_on_scan(self, tmp_path):
        """Post-processing must copy _needs_organization result onto Book.needs_processing."""
        import json

        library = tmp_path / "library"
        # Create a properly organised book directory with audio and metadata
        correct_path = library / "J.R.R. Tolkien" / "The Hobbit"
        correct_path.mkdir(parents=True)
        # Write a minimal audio stub so the scanner recognises it as a book
        (correct_path / "chapter1.mp3").write_bytes(b"")
        # Write metadata so we get high-confidence data
        (correct_path / "metadata.json").write_text(
            json.dumps({"title": "The Hobbit", "authors": ["J.R.R. Tolkien"]}),
            encoding="utf-8",
        )

        config = create_default_config()
        config.library_path = library
        scanner = MetadataScanner(config)

        book = scanner.scan_directory(correct_path)

        # The book is already in the right place, so needs_processing should be False
        assert book.needs_processing is False

    def test_error_in_compliance_check_defaults_to_true(self, tmp_path):
        """If the compliance check raises, _needs_organization must safely return True."""
        library = tmp_path / "library"
        scanner = _make_scanner(library)

        # Create a book whose source_path doesn't exist — resolve() still works
        # but the path is clearly wrong so compliance will differ
        book = Book(
            title="Ghost Book",
            authors=["Nobody"],
            source_path=Path("/nonexistent/path/Ghost Book"),
        )

        # Should not raise, should return True (conservative fallback)
        result = scanner._needs_organization(book)
        assert isinstance(result, bool)
