"""Audiobookshelf API helpers for library maintenance tasks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

import httpx


AnchorGenre = str

GENRE_MAPPING: Dict[str, AnchorGenre] = {
    "Epic": "Fantasy",
    "Sword & Sorcery": "Fantasy",
    "Dragons": "Fantasy",
    "Drizzt": "Fantasy",
    "Hard Science Fiction": "Science Fiction",
    "Space Opera": "Science Fiction",
    "Post-Apocalyptic": "Science Fiction",
    "Dystopian": "Science Fiction",
    "Robots": "Science Fiction",
    "Sci-Fi": "Science Fiction",
    "Amateur Sleuths": "Mystery",
    "Cozy": "Mystery",
    "Women Sleuths": "Mystery",
    "Police Procedurals": "Mystery",
    "Crime Thrillers": "Thriller & Suspense",
    "Psychological": "Thriller & Suspense",
    "Suspense": "Thriller & Suspense",
    "Domestic Thrillers": "Thriller & Suspense",
    "Women's Fiction": "Literature & Fiction",
    "Literary Fiction": "Literature & Fiction",
    "Family Life": "Literature & Fiction",
    "Humorous": "Comedy",
    "Comedy": "Comedy",
    "Presidents": "History & Politics",
    "American Civil War": "History & Politics",
    "World War II": "History & Politics",
    "Leadership": "Business & Leadership",
    "Management": "Business & Leadership",
    "Juvenile": "Children & YA",
    "Teen": "Children & YA",
    "Young Adult": "Children & YA",
}

DISCARD_GENRES = [
    "Abandonment of automobiles",
    "Waitresses",
    "Berwickshire",
    "Clocks and watches",
    "Hugo Award",
    "Nebula Award",
    "Locus Award",
]


class ABSMaintenanceError(RuntimeError):
    """Raised when the Audiobookshelf API rejects a maintenance request."""

    def __init__(
        self,
        message: str,
        *,
        diagnostics: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or []


@dataclass
class GenreCleanupChange:
    """A single library item genre change."""

    id: str
    title: str
    before: List[str]
    after: List[str]
    updated: bool = False
    error: Optional[str] = None


@dataclass
class GenreCleanupResult:
    """Summary of a genre cleanup preview or write run."""

    write: bool
    keep_unmapped: bool
    total_items: int
    changed_items: List[GenreCleanupChange] = field(default_factory=list)
    diagnostics: List[Dict[str, Any]] = field(default_factory=list)
    libraries: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def changed_count(self) -> int:
        return len(self.changed_items)

    @property
    def updated_count(self) -> int:
        return len([change for change in self.changed_items if change.updated])

    @property
    def error_count(self) -> int:
        return len([change for change in self.changed_items if change.error])


def clean_genres(
    original_genres: Iterable[str],
    *,
    keep_unmapped: bool = True,
    mapping: Dict[str, AnchorGenre] = GENRE_MAPPING,
    discard_genres: Iterable[str] = DISCARD_GENRES,
) -> List[str]:
    """Normalize raw ABS genre strings into the configured anchor taxonomy."""
    discard_values = [genre.lower() for genre in discard_genres]
    cleaned = set()

    for raw_genre in original_genres:
        split_genres = [
            genre.strip() for genre in raw_genre.split(",") if genre.strip()
        ]

        for genre in split_genres:
            normalized = genre.lower()

            if any(discard in normalized for discard in discard_values):
                continue

            matched = False
            for messy, anchor in mapping.items():
                if messy.lower() in normalized:
                    cleaned.add(anchor)
                    matched = True

            if not matched and keep_unmapped:
                cleaned.add(genre)

    return sorted(cleaned)


def genres_equal(left: Iterable[str], right: Iterable[str]) -> bool:
    """Compare genre lists without treating ordering as a change."""
    return sorted(left) == sorted(right)


class ABSMaintenanceClient:
    """Small client for the Audiobookshelf endpoints used by maintenance tasks."""

    def __init__(self, base_url: str, api_token: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token
        self.timeout = timeout
        self.diagnostics: List[Dict[str, Any]] = []

    async def clean_library_genres(
        self,
        library_id: str,
        *,
        keep_unmapped: bool = True,
        write: bool = False,
    ) -> GenreCleanupResult:
        headers = {"Authorization": f"Bearer {self.api_token}"}

        async with httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            libraries = await self._fetch_libraries(client)
            books = await self._fetch_library_items(client, library_id)
            changes = self._build_genre_changes(books, keep_unmapped=keep_unmapped)
            result = GenreCleanupResult(
                write=write,
                keep_unmapped=keep_unmapped,
                total_items=len(books),
                changed_items=changes,
                diagnostics=self.diagnostics,
                libraries=libraries,
            )

            if write:
                for change in result.changed_items:
                    try:
                        await self._update_item_genres(client, change.id, change.after)
                        change.updated = True
                    except ABSMaintenanceError as exc:
                        change.error = str(exc)
                        self.diagnostics.extend(exc.diagnostics)

            result.diagnostics = self.diagnostics
            return result

    async def list_libraries(self) -> List[Dict[str, Any]]:
        """Return libraries available to the configured ABS token."""
        headers = {"Authorization": f"Bearer {self.api_token}"}

        async with httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            return await self._fetch_libraries(client)

    async def _fetch_libraries(self, client: httpx.AsyncClient) -> List[Dict[str, Any]]:
        response = await self._request(client, "GET", "/api/libraries")
        payload = self._json_payload(response)
        libraries = payload.get("libraries", []) if isinstance(payload, dict) else []

        if not isinstance(libraries, list):
            raise ABSMaintenanceError(
                "Unexpected ABS response: libraries is not a list",
                diagnostics=self.diagnostics,
            )

        return [
            {
                "id": str(library.get("id", "")),
                "name": str(library.get("name", "")),
                "mediaType": library.get("mediaType"),
                "folders": [
                    folder.get("fullPath")
                    for folder in library.get("folders", [])
                    if isinstance(folder, dict)
                ],
            }
            for library in libraries
            if isinstance(library, dict)
        ]

    async def _fetch_library_items(
        self,
        client: httpx.AsyncClient,
        library_id: str,
    ) -> List[dict]:
        response = await self._request(
            client,
            "GET",
            f"/api/libraries/{library_id}/items?limit=0",
        )
        payload = self._json_payload(response)
        results = payload.get("results", [])
        if not isinstance(results, list):
            raise ABSMaintenanceError(
                "Unexpected ABS response: results is not a list",
                diagnostics=self.diagnostics,
            )

        return results

    def _build_genre_changes(
        self,
        books: Iterable[dict],
        *,
        keep_unmapped: bool,
    ) -> List[GenreCleanupChange]:
        changes = []

        for book in books:
            book_id = str(book.get("id", ""))
            media = book.get("media", {})
            metadata = media.get("metadata", {}) if isinstance(media, dict) else {}
            title = metadata.get("title") if isinstance(metadata, dict) else None
            raw_genres = metadata.get("genres", []) if isinstance(metadata, dict) else []
            original_genres = raw_genres if isinstance(raw_genres, list) else []
            original_genres = [str(genre) for genre in original_genres]
            updated_genres = clean_genres(
                original_genres,
                keep_unmapped=keep_unmapped,
            )

            if book_id and not genres_equal(original_genres, updated_genres):
                changes.append(
                    GenreCleanupChange(
                        id=book_id,
                        title=str(title or book_id),
                        before=original_genres,
                        after=updated_genres,
                    )
                )

        return changes

    async def _update_item_genres(
        self,
        client: httpx.AsyncClient,
        item_id: str,
        genres: List[str],
    ) -> None:
        await self._request(
            client,
            "PATCH",
            f"/api/items/{item_id}/media",
            json={"metadata": {"genres": genres}},
        )

    async def _request(
        self,
        client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
    ) -> httpx.Response:
        event: Dict[str, Any] = {
            "method": method,
            "path": path,
            "url": f"{self.base_url}{path}",
            "requestBody": self._summarize_body(json),
        }

        try:
            response = await client.request(method, path, json=json)
        except httpx.HTTPError as exc:
            event["error"] = str(exc)
            self.diagnostics.append(event)
            raise ABSMaintenanceError(str(exc), diagnostics=self.diagnostics) from exc

        event.update(
            {
                "status": response.status_code,
                "contentType": response.headers.get("content-type"),
                "location": response.headers.get("location"),
                "responseSnippet": response.text[:1000],
            }
        )
        self.diagnostics.append(event)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ABSMaintenanceError(
                self._format_http_error(exc.response),
                diagnostics=self.diagnostics,
            ) from exc

        return response

    def _summarize_body(
        self,
        body: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if body is None:
            return None

        metadata = body.get("metadata")
        if isinstance(metadata, dict) and "genres" in metadata:
            genres = metadata.get("genres", [])
            return {
                "metadata": {
                    "genresCount": len(genres) if isinstance(genres, list) else None
                }
            }

        return {"keys": sorted(body.keys())}

    def _json_payload(self, response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError as exc:
            raise ABSMaintenanceError(
                "ABS response was not valid JSON",
                diagnostics=self.diagnostics,
            ) from exc

    def _format_http_error(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return f"HTTP {response.status_code}: {response.text}"

        if isinstance(payload, dict):
            detail = (
                payload.get("detail")
                or payload.get("message")
                or payload.get("error")
                or payload
            )
            return f"HTTP {response.status_code}: {detail}"

        return f"HTTP {response.status_code}: {payload}"
