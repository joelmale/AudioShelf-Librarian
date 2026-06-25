"""
Tests for the ABS-identity fields added to the Book model.

abs_item_id and abs_library_id are populated when books are sourced from the
ABS REST API rather than a local filesystem scan.  They must:
  - Default to None for books created without API context
  - Accept any string value when provided
  - Survive round-trip serialisation (dict/JSON)
"""

from pathlib import Path

import pytest

from audioshelf_librarian.models import Book


class TestBookAbsIdFields:
    """Tests for abs_item_id and abs_library_id on the Book model."""

    def test_abs_item_id_defaults_to_none(self):
        """Books created without ABS context must have abs_item_id=None."""
        book = Book(title="Test Book", source_path=Path("/test"))
        assert book.abs_item_id is None

    def test_abs_library_id_defaults_to_none(self):
        """Books created without ABS context must have abs_library_id=None."""
        book = Book(title="Test Book", source_path=Path("/test"))
        assert book.abs_library_id is None

    def test_abs_item_id_can_be_set(self):
        """abs_item_id should accept any string value."""
        book = Book(
            title="Test Book",
            source_path=Path("/test"),
            abs_item_id="li_abc123",
        )
        assert book.abs_item_id == "li_abc123"

    def test_abs_library_id_can_be_set(self):
        """abs_library_id should accept any string value."""
        book = Book(
            title="Test Book",
            source_path=Path("/test"),
            abs_library_id="lib_xyz",
        )
        assert book.abs_library_id == "lib_xyz"

    def test_both_abs_ids_can_be_set_together(self):
        """Both IDs can be present simultaneously."""
        book = Book(
            title="Test Book",
            source_path=Path("/test"),
            abs_item_id="li_abc123",
            abs_library_id="lib_xyz",
        )
        assert book.abs_item_id == "li_abc123"
        assert book.abs_library_id == "lib_xyz"

    def test_abs_ids_survive_dict_round_trip(self):
        """IDs must be preserved through .dict() serialisation."""
        book = Book(
            title="Test Book",
            source_path=Path("/test"),
            abs_item_id="li_abc123",
            abs_library_id="lib_xyz",
        )
        data = book.dict()
        assert data["abs_item_id"] == "li_abc123"
        assert data["abs_library_id"] == "lib_xyz"

    def test_abs_ids_survive_model_reconstruction(self):
        """A Book reconstructed from its dict should retain ABS IDs."""
        original = Book(
            title="Test Book",
            source_path=Path("/test"),
            abs_item_id="li_abc123",
            abs_library_id="lib_xyz",
        )
        reconstructed = Book(**original.dict())
        assert reconstructed.abs_item_id == "li_abc123"
        assert reconstructed.abs_library_id == "lib_xyz"

    def test_other_book_fields_unaffected(self):
        """Adding ABS ID fields must not break existing Book behaviour."""
        book = Book(
            title="My Book",
            source_path=Path("/library/My Book"),
            authors=["Jane Doe"],
            series="My Series",
            series_number=2.0,
            is_series=True,
            abs_item_id="li_001",
        )
        assert book.title == "My Book"
        assert book.primary_author == "Jane Doe"
        assert book.formatted_series_number == "2"
        assert book.abs_item_id == "li_001"
        assert book.abs_library_id is None
