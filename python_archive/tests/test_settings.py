import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from audioshelf_librarian.settings import SettingsStore


def test_settings_store_encrypts_api_token(tmp_path):
    store = SettingsStore(
        settings_file=tmp_path / "settings.json",
        key_file=tmp_path / "settings.key",
    )

    settings = store.save(
        abs_url="https://abs.example.test",
        api_token="secret-token",
        library_id="library-id",
        debug_mode=True,
    )

    settings_text = (tmp_path / "settings.json").read_text()
    assert "secret-token" not in settings_text
    assert settings.api_token_configured is True
    assert store.decrypt_api_token(settings) == "secret-token"


def test_settings_store_keeps_existing_token_when_blank_token_saved(tmp_path):
    store = SettingsStore(
        settings_file=tmp_path / "settings.json",
        key_file=tmp_path / "settings.key",
    )

    store.save(
        abs_url="https://first.example.test",
        api_token="secret-token",
        library_id="first-library",
        debug_mode=False,
    )
    settings = store.save(
        abs_url="https://second.example.test",
        api_token="",
        library_id="second-library",
        debug_mode=True,
    )

    assert settings.abs_url == "https://second.example.test"
    assert settings.library_id == "second-library"
    assert settings.debug_mode is True
    assert store.decrypt_api_token(settings) == "secret-token"
