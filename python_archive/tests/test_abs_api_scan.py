"""
Tests for the ABS-API-first scan mode.

Covers:
  - ABSMaintenanceClient.fetch_library_items_as_books()
  - ABSMaintenanceClient._map_item_to_book()  (static helper)

HTTP calls are intercepted with pytest-httpx / unittest.mock so no real
ABS server is needed.
"""

from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from audioshelf_librarian.abs_maintenance import ABSMaintenanceClient
from audioshelf_librarian.models import Book, MetadataSource


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _make_client() -> ABSMaintenanceClient:
    return ABSMaintenanceClient("https://abs.example.test", "test-token")


def _make_raw_item(
    *,
    item_id: str = "li_001",
    path: str = "/audiobooks/Author/Title",
    title: str = "Test Book",
    authors: List[Any] = None,
    series: List[Any] = None,
    publisher: str = None,
    narrator: str = None,
    publish_year: str = None,
) -> Dict[str, Any]:
    """Build a minimal ABS library-item dict."""
    metadata: Dict[str, Any] = {"title": title}
    if authors is not None:
        metadata["authors"] = authors
    if series is not None:
        metadata["series"] = series
    if publisher:
        metadata["publisher"] = publisher
    if narrator:
        metadata["narrator"] = narrator
    if publish_year:
        metadata["publishYear"] = publish_year

    return {
        "id": item_id,
        "path": path,
        "media": {"metadata": metadata},
    }


# ---------------------------------------------------------------------------
# _map_item_to_book (static, no network needed)
# ---------------------------------------------------------------------------

class TestMapItemToBook:
    """Unit tests for _map_item_to_book with various item shapes."""

    def _map(self, item: dict) -> Book:
        return ABSMaintenanceClient._map_item_to_book(
            item,
            library_id="lib_xyz",
            book_cls=Book,
            metadata_source=MetadataSource.ABS_JSON,
        )

    def test_basic_mapping(self):
        item = _make_raw_item(
            item_id="li_001",
            path="/audiobooks/J.R.R. Tolkien/The Hobbit",
            title="The Hobbit",
            authors=[{"id": "a1", "name": "J.R.R. Tolkien"}],
        )
        book = self._map(item)

        assert book.title == "The Hobbit"
        assert book.authors == ["J.R.R. Tolkien"]
        assert book.abs_item_id == "li_001"
        assert book.abs_library_id == "lib_xyz"
        assert book.source_path == Path("/audiobooks/J.R.R. Tolkien/The Hobbit")
        assert book.confidence_score == 1.0
        assert book.metadata_source == MetadataSource.ABS_JSON

    def test_string_authors_handled(self):
        item = _make_raw_item(
            authors=["Author One", "Author Two"],
        )
        book = self._map(item)
        assert book.authors == ["Author One", "Author Two"]

    def test_series_mapped(self):
        item = _make_raw_item(
            series=[{"name": "The Expanse", "sequence": "1"}],
        )
        book = self._map(item)

        assert book.series == "The Expanse"
        assert book.series_number == 1.0
        assert book.is_series is True

    def test_non_numeric_series_sequence_becomes_none(self):
        item = _make_raw_item(
            series=[{"name": "Some Series", "sequence": "N/A"}],
        )
        book = self._map(item)

        assert book.series == "Some Series"
        assert book.series_number is None
        assert book.is_series is False

    def test_empty_series_list(self):
        item = _make_raw_item(series=[])
        book = self._map(item)

        assert book.series is None
        assert book.is_series is False

    def test_missing_id_returns_none(self):
        item = {"path": "/some/path", "media": {"metadata": {"title": "X"}}}
        result = ABSMaintenanceClient._map_item_to_book(
            item,
            library_id="lib",
            book_cls=Book,
            metadata_source=MetadataSource.ABS_JSON,
        )
        assert result is None

    def test_missing_path_returns_none(self):
        item = {"id": "li_999", "media": {"metadata": {"title": "X"}}}
        result = ABSMaintenanceClient._map_item_to_book(
            item,
            library_id="lib",
            book_cls=Book,
            metadata_source=MetadataSource.ABS_JSON,
        )
        assert result is None

    def test_fallback_title_from_path(self):
        """When title is absent, last segment of path is used."""
        item = {
            "id": "li_001",
            "path": "/audiobooks/Author/My Great Book",
            "media": {"metadata": {}},
        }
        book = self._map(item)
        assert book.title == "My Great Book"

    def test_publish_year_parsed(self):
        item = _make_raw_item(publish_year="2001")
        book = self._map(item)
        assert book.published_year == 2001

    def test_non_numeric_publish_year_becomes_none(self):
        item = _make_raw_item(publish_year="unknown")
        book = self._map(item)
        assert book.published_year is None

    def test_publisher_mapped(self):
        item = _make_raw_item(publisher="Tor Books")
        book = self._map(item)
        assert book.publisher == "Tor Books"

    def test_narrator_mapped(self):
        item = _make_raw_item(narrator="Roy Dotrice")
        book = self._map(item)
        assert book.narrator == "Roy Dotrice"

    def test_dict_author_missing_name_skipped(self):
        """Dicts without a 'name' key must be dropped, not crash."""
        item = _make_raw_item(
            authors=[
                {"id": "bad"},                        # no 'name'
                {"id": "ok", "name": "Good Author"},  # valid
            ],
        )
        book = self._map(item)
        assert book.authors == ["Good Author"]


# ---------------------------------------------------------------------------
# fetch_library_items_as_books (requires mocking HTTP)
# ---------------------------------------------------------------------------

class TestFetchLibraryItemsAsBooks:
    """Integration-style tests for fetch_library_items_as_books with mocked HTTP."""

    @pytest.mark.asyncio
    async def test_returns_list_of_books(self):
        """Should return a list of Book objects from the mocked response."""
        raw_items = [
            _make_raw_item(
                item_id="li_001",
                path="/audiobooks/J.R.R. Tolkien/The Hobbit",
                title="The Hobbit",
                authors=[{"id": "a1", "name": "J.R.R. Tolkien"}],
            ),
            _make_raw_item(
                item_id="li_002",
                path="/audiobooks/Frank Herbert/Dune",
                title="Dune",
                authors=[{"id": "a2", "name": "Frank Herbert"}],
            ),
        ]
        api_response = {"results": raw_items, "total": 2, "limit": 0, "page": 0}

        client = _make_client()

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 200
            response.headers = {"content-type": "application/json"}
            response.text = str(api_response)
            response.json.return_value = api_response
            response.raise_for_status = MagicMock()
            instance.request = AsyncMock(return_value=response)

            books = await client.fetch_library_items_as_books("lib_xyz")

        assert len(books) == 2
        assert all(isinstance(b, Book) for b in books)
        assert books[0].abs_item_id == "li_001"
        assert books[0].abs_library_id == "lib_xyz"
        assert books[1].abs_item_id == "li_002"

    @pytest.mark.asyncio
    async def test_items_without_id_or_path_skipped(self):
        """Items missing id or path must be silently dropped."""
        raw_items = [
            {"media": {"metadata": {"title": "No ID"}}},           # no id
            {"id": "li_001", "media": {"metadata": {"title": "No Path"}}},  # no path
            _make_raw_item(item_id="li_good", path="/a/b", title="Valid"),
        ]
        api_response = {"results": raw_items}

        client = _make_client()

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 200
            response.headers = {"content-type": "application/json"}
            response.text = str(api_response)
            response.json.return_value = api_response
            response.raise_for_status = MagicMock()
            instance.request = AsyncMock(return_value=response)

            books = await client.fetch_library_items_as_books("lib_xyz")

        assert len(books) == 1
        assert books[0].abs_item_id == "li_good"

    @pytest.mark.asyncio
    async def test_empty_library_returns_empty_list(self):
        """An empty results list must return an empty list without error."""
        api_response = {"results": []}

        client = _make_client()

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 200
            response.headers = {"content-type": "application/json"}
            response.text = str(api_response)
            response.json.return_value = api_response
            response.raise_for_status = MagicMock()
            instance.request = AsyncMock(return_value=response)

            books = await client.fetch_library_items_as_books("lib_xyz")

        assert books == []
