"""
Shared application configuration factory.

Both the CLI (main.py) and web application (web_app.py) need the same
default Configuration object.  Defining it here once eliminates drift
between the two entry-points.
"""

from pathlib import Path

from .models import Configuration, MetadataSource


def create_default_config() -> Configuration:
    """Return a Configuration object populated with sensible defaults.

    The library and inbox paths default to ``/audiobooks`` and
    ``/audiobooks/inbox`` which match the Docker volume convention used in
    ``docker-compose.yml``.  All other settings can be overridden by callers
    before use.
    """
    return Configuration(
        library_path=Path("/audiobooks"),
        inbox_path=Path("/audiobooks/inbox"),
        prefer_series_structure=True,
        include_year_in_titles=False,
        include_narrator_in_names=False,
        metadata_source_priority=[
            MetadataSource.ABS_JSON,
            MetadataSource.ID3_TAGS,
            MetadataSource.FILENAME,
        ],
        require_confirmation=True,
        create_backups=True,
        scan_subdirectories=True,
        skip_hidden_files=True,
        minimum_confidence_threshold=0.5,
    )
