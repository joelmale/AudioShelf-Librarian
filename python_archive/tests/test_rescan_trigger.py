"""
Tests for the post-move ABS library rescan trigger.

Covers:
  - ABSMaintenanceClient.trigger_library_scan() returns True on HTTP 200
  - Returns False when ABS returns an error (non-fatal)
  - The web execute_file_operations flow calls trigger_library_scan when
    ABS connection settings are configured and file moves succeeded
  - Trigger is NOT called when no files were moved (success_count == 0)
  - Trigger is NOT called when ABS settings are absent
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from audioshelf_librarian.abs_maintenance import ABSMaintenanceClient, ABSMaintenanceError


# ---------------------------------------------------------------------------
# trigger_library_scan unit tests
# ---------------------------------------------------------------------------

class TestTriggerLibraryScan:
    """Tests for ABSMaintenanceClient.trigger_library_scan()."""

    @pytest.mark.asyncio
    async def test_returns_true_on_success(self):
        """When ABS returns HTTP 200, trigger_library_scan must return True."""
        client = ABSMaintenanceClient("https://abs.example.test", "tok")

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 200
            response.headers = {"content-type": "application/json"}
            response.text = "{}"
            response.json.return_value = {}
            response.raise_for_status = MagicMock()
            instance.request = AsyncMock(return_value=response)

            result = await client.trigger_library_scan("lib_xyz")

        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_on_abs_error(self):
        """When ABS returns an error, trigger_library_scan must return False (not raise)."""
        client = ABSMaintenanceClient("https://abs.example.test", "tok")

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 500
            response.headers = {"content-type": "text/plain"}
            response.text = "Internal Server Error"
            response.json.side_effect = Exception("not JSON")
            response.raise_for_status = MagicMock(
                side_effect=Exception("HTTP 500")
            )
            instance.request = AsyncMock(return_value=response)

            # Should not raise
            result = await client.trigger_library_scan("lib_xyz")

        assert result is False

    @pytest.mark.asyncio
    async def test_posts_to_correct_endpoint(self):
        """Must POST to /api/libraries/{library_id}/scan."""
        client = ABSMaintenanceClient("https://abs.example.test", "tok")

        with patch("httpx.AsyncClient") as mock_http:
            instance = mock_http.return_value.__aenter__.return_value
            response = MagicMock()
            response.status_code = 200
            response.headers = {"content-type": "application/json"}
            response.text = "{}"
            response.json.return_value = {}
            response.raise_for_status = MagicMock()
            instance.request = AsyncMock(return_value=response)

            await client.trigger_library_scan("lib_test123")

        call_args = instance.request.call_args
        method, url = call_args.args[:2] if call_args.args else (
            call_args.kwargs.get("method"),
            call_args.kwargs.get("url"),
        )
        assert method == "POST"
        assert "/api/libraries/lib_test123/scan" in str(url)


# ---------------------------------------------------------------------------
# Web app execute_file_operations integration tests
# ---------------------------------------------------------------------------

class TestWebAppRescanTrigger:
    """
    Test that execute_file_operations triggers ABS rescan under the right conditions.

    We mock settings_store so no real filesystem or network access is needed.
    """

    def _make_mock_settings(
        self,
        *,
        abs_url: str = "https://abs.example.test",
        library_id: str = "lib_xyz",
        api_token: str = "test-token",
    ):
        """Return mocked AppSettings + SettingsStore."""
        from audioshelf_librarian.settings import AppSettings

        settings = AppSettings(
            abs_url=abs_url,
            library_id=library_id,
            encrypted_api_token="encrypted",
        )
        store = MagicMock()
        store.load.return_value = settings
        store.decrypt_api_token.return_value = api_token
        return store

    @pytest.mark.asyncio
    async def test_rescan_triggered_after_successful_moves(self, tmp_path):
        """
        When file moves succeed and ABS settings are configured, the rescan
        trigger must be called exactly once.
        """
        from audioshelf_librarian.web_app import execute_file_operations, active_operations

        # Set up a real source file so shutil.move succeeds
        src = tmp_path / "src_book"
        src.mkdir()
        (src / "audio.mp3").write_bytes(b"")
        tgt = tmp_path / "library" / "Author" / "Title"

        action_dict = {
            "action_type": "move",
            "source_path": str(src),
            "target_path": str(tgt),
            "book": {"title": "Test Book", "authors": ["Author"]},
        }

        op_id = "test-exec-op"
        active_operations[op_id] = {
            "id": op_id,
            "type": "execute",
            "status": "running",
            "cancelled": False,
        }

        mock_store = self._make_mock_settings()
        mock_trigger = AsyncMock(return_value=True)

        with (
            patch("audioshelf_librarian.web_app.settings_store", mock_store),
            patch(
                "audioshelf_librarian.web_app.ABSMaintenanceClient"
            ) as mock_client_cls,
        ):
            mock_client_instance = MagicMock()
            mock_client_instance.trigger_library_scan = mock_trigger
            mock_client_cls.return_value = mock_client_instance

            await execute_file_operations(op_id, [action_dict], [0])

        mock_trigger.assert_called_once_with("lib_xyz")
        assert active_operations[op_id].get("abs_rescan_triggered") is True

    @pytest.mark.asyncio
    async def test_rescan_not_triggered_when_no_moves(self, tmp_path):
        """When no files were successfully moved, rescan must NOT be triggered."""
        from audioshelf_librarian.web_app import execute_file_operations, active_operations

        # Action with a nonexistent source — will fail → success_count stays 0
        action_dict = {
            "action_type": "move",
            "source_path": str(tmp_path / "nonexistent"),
            "target_path": str(tmp_path / "target"),
            "book": {"title": "Ghost", "authors": ["Nobody"]},
        }

        op_id = "test-exec-op-noop"
        active_operations[op_id] = {
            "id": op_id,
            "type": "execute",
            "status": "running",
            "cancelled": False,
        }

        mock_store = self._make_mock_settings()
        mock_trigger = AsyncMock(return_value=True)

        with (
            patch("audioshelf_librarian.web_app.settings_store", mock_store),
            patch(
                "audioshelf_librarian.web_app.ABSMaintenanceClient"
            ) as mock_client_cls,
        ):
            mock_client_instance = MagicMock()
            mock_client_instance.trigger_library_scan = mock_trigger
            mock_client_cls.return_value = mock_client_instance

            await execute_file_operations(op_id, [action_dict], [0])

        mock_trigger.assert_not_called()

    @pytest.mark.asyncio
    async def test_rescan_not_triggered_when_no_abs_settings(self, tmp_path):
        """When ABS settings are absent, rescan must NOT be triggered."""
        from audioshelf_librarian.web_app import execute_file_operations, active_operations

        src = tmp_path / "src_book2"
        src.mkdir()
        tgt = tmp_path / "library2" / "Title"

        action_dict = {
            "action_type": "move",
            "source_path": str(src),
            "target_path": str(tgt),
            "book": {"title": "Test", "authors": ["A"]},
        }

        op_id = "test-exec-op-nosettings"
        active_operations[op_id] = {
            "id": op_id,
            "type": "execute",
            "status": "running",
            "cancelled": False,
        }

        # Settings with empty abs_url / library_id / api_token
        mock_store = self._make_mock_settings(abs_url="", library_id="", api_token="")
        mock_trigger = AsyncMock(return_value=True)

        with (
            patch("audioshelf_librarian.web_app.settings_store", mock_store),
            patch(
                "audioshelf_librarian.web_app.ABSMaintenanceClient"
            ) as mock_client_cls,
        ):
            mock_client_instance = MagicMock()
            mock_client_instance.trigger_library_scan = mock_trigger
            mock_client_cls.return_value = mock_client_instance

            await execute_file_operations(op_id, [action_dict], [0])

        mock_trigger.assert_not_called()
