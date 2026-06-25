"""
Tests for MetadataScanner._scan_from_abs_json author-parsing robustness.

ABS stores authors in two formats depending on version:
  - Plain strings:  ["Brandon Sanderson"]
  - Dict objects:   [{"id": "auth-1", "name": "Brandon Sanderson"}]

Both must produce the same flat list of name strings.
"""

import json
import tempfile
from pathlib import Path

import pytest

from audioshelf_librarian.models import Configuration
from audioshelf_librarian.scanner import MetadataScanner


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def config(tmp_path):
    return Configuration(
        library_path=tmp_path / "library",
        inbox_path=tmp_path / "inbox",
    )


@pytest.fixture
def scanner(config):
    return MetadataScanner(config)


def _write_metadata(directory: Path, payload: dict) -> Path:
    """Write a metadata.json file into *directory* and return the file path."""
    directory.mkdir(parents=True, exist_ok=True)
    meta_file = directory / "metadata.json"
    meta_file.write_text(json.dumps(payload), encoding="utf-8")
    return meta_file


# ---------------------------------------------------------------------------
# Author format tests
# ---------------------------------------------------------------------------

class TestAbsJsonAuthorParsing:
    """Ensure _scan_from_abs_json unwraps both ABS author formats correctly."""

    def test_string_authors_preserved(self, scanner, tmp_path):
        """Plain string authors should be returned as-is."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "Test Book",
            "authors": ["Brandon Sanderson", "Mary Shelley"],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["authors"] == ["Brandon Sanderson", "Mary Shelley"]

    def test_dict_authors_unwrapped(self, scanner, tmp_path):
        """ABS dict-format authors {id, name} must be reduced to name strings."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "Test Book",
            "authors": [
                {"id": "auth-abc", "name": "Brandon Sanderson"},
                {"id": "auth-xyz", "name": "Mary Shelley"},
            ],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["authors"] == ["Brandon Sanderson", "Mary Shelley"]

    def test_mixed_author_formats(self, scanner, tmp_path):
        """A list mixing strings and dicts should be handled gracefully."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "Test Book",
            "authors": [
                "Mary Shelley",
                {"id": "auth-abc", "name": "Brandon Sanderson"},
            ],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert "Mary Shelley" in result["authors"]
        assert "Brandon Sanderson" in result["authors"]
        assert len(result["authors"]) == 2

    def test_empty_authors_list(self, scanner, tmp_path):
        """Empty authors list should return an empty list (not crash)."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "Test Book",
            "authors": [],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["authors"] == []

    def test_missing_authors_key(self, scanner, tmp_path):
        """Absent authors key should default to empty list."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {"title": "Test Book"})

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["authors"] == []

    def test_dict_author_with_no_name_key_skipped(self, scanner, tmp_path):
        """Dict authors missing the 'name' key should be silently skipped."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "Test Book",
            "authors": [
                {"id": "auth-abc"},                          # no 'name' key → skipped
                {"id": "auth-xyz", "name": "Mary Shelley"},  # valid
            ],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        # Only the valid dict should appear; the no-name dict is dropped
        assert result["authors"] == ["Mary Shelley"]
        assert len(result["authors"]) == 1

    def test_no_metadata_file_returns_none(self, scanner, tmp_path):
        """If no metadata.json exists, None should be returned."""
        book_dir = tmp_path / "book_no_meta"
        book_dir.mkdir()

        result = scanner._scan_from_abs_json(book_dir)

        assert result is None

    # -----------------------------------------------------------------------
    # Additional metadata fields
    # -----------------------------------------------------------------------

    def test_title_underscores_replaced(self, scanner, tmp_path):
        """Underscores in the title should be replaced with spaces."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "The_Way_of_Kings",
            "authors": ["Brandon Sanderson"],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["title"] == "The Way of Kings"

    def test_series_dict_format_parsed(self, scanner, tmp_path):
        """Series stored as a list of dicts should populate series_name/number."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {
            "title": "The Way of Kings",
            "authors": [{"id": "a1", "name": "Brandon Sanderson"}],
            "series": [{"name": "The Stormlight Archive", "sequence": "1"}],
        })

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result.get("series_name") == "The Stormlight Archive"
        assert result.get("series_number") == "1"

    def test_confidence_score_is_maximum(self, scanner, tmp_path):
        """ABS JSON should always carry confidence 1.0."""
        book_dir = tmp_path / "book"
        _write_metadata(book_dir, {"title": "Test", "authors": []})

        result = scanner._scan_from_abs_json(book_dir)

        assert result is not None
        assert result["confidence_score"] == 1.0
