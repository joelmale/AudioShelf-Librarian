"""Persistent application settings with encrypted secret storage."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from cryptography.fernet import Fernet, InvalidToken


CONFIG_DIR = Path.home() / ".audioshelf_librarian"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
KEY_FILE = CONFIG_DIR / "settings.key"


class SettingsError(RuntimeError):
    """Raised when persisted settings cannot be read or decrypted."""


@dataclass
class AppSettings:
    """Settings used by the maintenance web UI."""

    abs_url: str = ""
    library_id: str = ""
    library_name: str = ""
    library_folder: str = ""
    library_media_type: str = ""
    debug_mode: bool = False
    encrypted_api_token: str = ""

    @property
    def api_token_configured(self) -> bool:
        return bool(self.encrypted_api_token)


class SettingsStore:
    """Read and write app settings, encrypting API tokens at rest."""

    def __init__(
        self,
        settings_file: Path = SETTINGS_FILE,
        key_file: Path = KEY_FILE,
    ) -> None:
        self.settings_file = settings_file
        self.key_file = key_file

    def load(self) -> AppSettings:
        if not self.settings_file.exists():
            return AppSettings()

        try:
            payload = json.loads(self.settings_file.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise SettingsError(f"Could not read settings: {exc}") from exc

        return AppSettings(
            abs_url=str(payload.get("abs_url", "")),
            library_id=str(payload.get("library_id", "")),
            library_name=str(payload.get("library_name", "")),
            library_folder=str(payload.get("library_folder", "")),
            library_media_type=str(payload.get("library_media_type", "")),
            debug_mode=bool(payload.get("debug_mode", False)),
            encrypted_api_token=str(payload.get("encrypted_api_token", "")),
        )

    def save(
        self,
        *,
        abs_url: str,
        library_id: str,
        library_name: str = "",
        library_folder: str = "",
        library_media_type: str = "",
        debug_mode: bool,
        api_token: Optional[str] = None,
    ) -> AppSettings:
        current = self.load()
        encrypted_api_token = current.encrypted_api_token

        if api_token is not None and api_token.strip():
            encrypted_api_token = self._encrypt(api_token.strip())

        settings = AppSettings(
            abs_url=abs_url.strip(),
            library_id=library_id.strip(),
            library_name=library_name.strip(),
            library_folder=library_folder.strip(),
            library_media_type=library_media_type.strip(),
            debug_mode=debug_mode,
            encrypted_api_token=encrypted_api_token,
        )

        self._ensure_config_dir()
        payload = {
            "abs_url": settings.abs_url,
            "library_id": settings.library_id,
            "library_name": settings.library_name,
            "library_folder": settings.library_folder,
            "library_media_type": settings.library_media_type,
            "debug_mode": settings.debug_mode,
            "encrypted_api_token": settings.encrypted_api_token,
        }
        self.settings_file.write_text(json.dumps(payload, indent=2))
        self._chmod_private(self.settings_file)
        return settings

    def decrypt_api_token(self, settings: Optional[AppSettings] = None) -> str:
        loaded_settings = settings or self.load()
        if not loaded_settings.encrypted_api_token:
            return ""

        try:
            return self._fernet().decrypt(
                loaded_settings.encrypted_api_token.encode("utf-8")
            ).decode("utf-8")
        except InvalidToken as exc:
            raise SettingsError("Stored API token could not be decrypted") from exc

    def as_public_dict(self, settings: Optional[AppSettings] = None) -> Dict[str, Any]:
        loaded_settings = settings or self.load()
        return {
            "abs_url": loaded_settings.abs_url,
            "library_id": loaded_settings.library_id,
            "library_name": loaded_settings.library_name,
            "library_folder": loaded_settings.library_folder,
            "library_media_type": loaded_settings.library_media_type,
            "debug_mode": loaded_settings.debug_mode,
            "api_token_configured": loaded_settings.api_token_configured,
            "connection_configured": bool(
                loaded_settings.abs_url
                and loaded_settings.library_id
                and loaded_settings.api_token_configured
            ),
            "settings_file": str(self.settings_file),
        }

    def _encrypt(self, value: str) -> str:
        return self._fernet().encrypt(value.encode("utf-8")).decode("utf-8")

    def _fernet(self) -> Fernet:
        self._ensure_config_dir()
        if not self.key_file.exists():
            self.key_file.write_bytes(Fernet.generate_key())
            self._chmod_private(self.key_file)

        return Fernet(self.key_file.read_bytes())

    def _ensure_config_dir(self) -> None:
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        self._chmod_private(self.settings_file.parent)

    def _chmod_private(self, path: Path) -> None:
        try:
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        except OSError:
            pass
