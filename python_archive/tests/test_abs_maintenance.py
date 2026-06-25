import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from audioshelf_librarian.abs_maintenance import (
    ABSMaintenanceClient,
    ANCHOR_GENRES,
    clean_genres,
    genres_equal,
)


def test_clean_genres_maps_discards_and_splits_values():
    result = clean_genres(
        [
            "Epic, Sword & Sorcery",
            "hugo award",
            "Hard Science Fiction",
            "Literary Fiction",
        ]
    )

    assert result == ["Fantasy", "Literature & Fiction", "Science Fiction"]


def test_clean_genres_can_drop_unmapped_values():
    result = clean_genres(
        ["Epic", "Private Label", "Waitresses"],
        keep_unmapped=False,
    )

    assert result == ["Fantasy"]


def test_genres_equal_ignores_order():
    assert genres_equal(["Fantasy", "Mystery"], ["Mystery", "Fantasy"])


def test_default_mapping_can_produce_all_anchor_genres():
    result = clean_genres(
        [
            "Action",
            "Biography",
            "Business",
            "Juvenile",
            "Classic",
            "Comedy",
            "Epic",
            "Presidents",
            "Literary Fiction",
            "Cozy",
            "Nonfiction",
            "Romance",
            "Space Opera",
            "Suspense",
        ],
        keep_unmapped=False,
    )

    assert result == sorted(ANCHOR_GENRES)


def test_preview_unmapped_terms_are_covered_by_default_rules():
    result = clean_genres(
        [
            "Fiction",
            "Science Fiction & Fantasy",
            "Science Fiction",
            "Literature & Fiction",
            "Fantasy",
            "Mystery",
            "Contemporary",
            "Humor (Fiction)",
            "Graphic Audio",
            "Speech",
            "Historical",
            "Children's Audiobooks",
            "Military",
            "Politicians",
        ],
        keep_unmapped=False,
    )

    assert result == [
        "Children & YA",
        "Comedy",
        "Fantasy",
        "History & Politics",
        "Literature & Fiction",
        "Mystery",
        "Science Fiction",
    ]


def test_build_genre_changes_can_preserve_dropped_terms_as_tags():
    client = ABSMaintenanceClient("https://abs.example.test", "token")
    changes = client._build_genre_changes(
        [
            {
                "id": "item-1",
                "media": {
                    "metadata": {
                        "title": "Example",
                        "genres": ["Epic", "Private Label", "Waitresses"],
                        "tags": ["Existing"],
                    }
                },
            }
        ],
        keep_unmapped=False,
        preserve_dropped_as_tags=True,
    )

    assert len(changes) == 1
    assert changes[0].after == ["Fantasy"]
    assert changes[0].added_tags == ["Private Label", "Waitresses"]
    assert changes[0].after_tags == ["Existing", "Private Label", "Waitresses"]


def test_build_genre_changes_can_drop_terms_without_tagging():
    client = ABSMaintenanceClient("https://abs.example.test", "token")
    changes = client._build_genre_changes(
        [
            {
                "id": "item-1",
                "media": {
                    "metadata": {
                        "title": "Example",
                        "genres": ["Epic", "Private Label", "Waitresses"],
                        "tags": ["Existing"],
                    }
                },
            }
        ],
        keep_unmapped=False,
        preserve_dropped_as_tags=False,
    )

    assert len(changes) == 1
    assert changes[0].after == ["Fantasy"]
    assert changes[0].added_tags == []
    assert changes[0].after_tags == ["Existing"]
