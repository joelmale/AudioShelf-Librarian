import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from audioshelf_librarian.abs_maintenance import clean_genres, genres_equal


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
