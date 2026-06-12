"""
Tests for the shared create_default_config() factory in config.py.

Key goals:
- Both main.py and web_app.py now delegate to the same factory, so changing
  defaults in one place affects both.  These tests guard against drift by
  asserting on the canonical output of config.py directly.
- Verify that the function is importable from all three locations:
    audioshelf_librarian.config     (canonical)
    audioshelf_librarian.main       (re-export)
    audioshelf_librarian.web_app    (re-export)
"""

from pathlib import Path

import pytest

from audioshelf_librarian.config import create_default_config
from audioshelf_librarian.models import Configuration, MetadataSource


class TestCreateDefaultConfig:
    """Tests for the shared configuration factory."""

    def test_returns_configuration_instance(self):
        config = create_default_config()
        assert isinstance(config, Configuration)

    def test_default_library_path(self):
        config = create_default_config()
        assert config.library_path == Path("/audiobooks")

    def test_default_inbox_path(self):
        config = create_default_config()
        assert config.inbox_path == Path("/audiobooks/inbox")

    def test_prefers_series_structure(self):
        config = create_default_config()
        assert config.prefer_series_structure is True

    def test_year_not_included_by_default(self):
        config = create_default_config()
        assert config.include_year_in_titles is False

    def test_narrator_not_included_by_default(self):
        config = create_default_config()
        assert config.include_narrator_in_names is False

    def test_metadata_priority_order(self):
        """ABS JSON must be highest priority, then ID3, then filename."""
        config = create_default_config()
        assert config.metadata_source_priority == [
            MetadataSource.ABS_JSON,
            MetadataSource.ID3_TAGS,
            MetadataSource.FILENAME,
        ]

    def test_confirmation_required_by_default(self):
        config = create_default_config()
        assert config.require_confirmation is True

    def test_backups_enabled_by_default(self):
        config = create_default_config()
        assert config.create_backups is True

    def test_confidence_threshold(self):
        config = create_default_config()
        assert config.minimum_confidence_threshold == 0.5

    def test_config_is_mutable_after_creation(self):
        """Callers must be able to override individual fields."""
        config = create_default_config()
        config.library_path = Path("/my/audiobooks")
        assert config.library_path == Path("/my/audiobooks")

    def test_each_call_returns_independent_instance(self):
        """Two calls must not share state."""
        config_a = create_default_config()
        config_b = create_default_config()
        config_a.library_path = Path("/custom")
        assert config_b.library_path == Path("/audiobooks")


class TestConfigImportEquivalence:
    """Verify that main.py and web_app.py now use the same factory."""

    def test_main_exports_create_default_config(self):
        """main.py must expose create_default_config (re-exported from config.py)."""
        from audioshelf_librarian import main
        assert hasattr(main, "create_default_config") or callable(
            getattr(main, "create_default_config", None)
        )

    def test_main_config_matches_canonical(self):
        """Config returned from main.py import is identical to config.py output."""
        from audioshelf_librarian.config import create_default_config as canonical
        from audioshelf_librarian.main import create_default_config as from_main

        assert canonical().dict() == from_main().dict()

    def test_web_app_config_matches_canonical(self):
        """Config returned from web_app.py import is identical to config.py output."""
        from audioshelf_librarian.config import create_default_config as canonical
        from audioshelf_librarian.web_app import create_default_config as from_web

        assert canonical().dict() == from_web().dict()
