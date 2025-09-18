"""
Basic tests for the AudioShelf Librarian CLI and core functionality.

These tests verify that the main components work correctly and can handle
basic use cases without errors.
"""

import pytest
from pathlib import Path
import tempfile
import shutil
from unittest.mock import Mock, patch

from audioshelf_librarian.models import Book, Configuration, MetadataSource
from audioshelf_librarian.scanner import MetadataScanner
from audioshelf_librarian.organizer import AudiobookOrganizer
from audioshelf_librarian.main import create_default_config


class TestConfiguration:
    """Test configuration creation and validation."""
    
    def test_default_config_creation(self):
        """Test that default configuration is created correctly."""
        config = create_default_config()
        
        assert isinstance(config, Configuration)
        assert config.library_path == Path("/audiobooks")
        assert config.inbox_path == Path("/audiobooks/inbox")
        assert config.prefer_series_structure is True
        assert MetadataSource.ABS_JSON in config.metadata_source_priority
    
    def test_config_validation(self):
        """Test configuration validation."""
        config = Configuration(
            library_path=Path("/test"),
            inbox_path=Path("/test/inbox"),
            minimum_confidence_threshold=0.7
        )
        
        assert config.minimum_confidence_threshold == 0.7
        
        # Test invalid confidence threshold
        with pytest.raises(ValueError):
            Configuration(
                library_path=Path("/test"),
                inbox_path=Path("/test/inbox"),
                minimum_confidence_threshold=1.5  # Invalid - over 1.0
            )


class TestBookModel:
    """Test the Book data model."""
    
    def test_book_creation(self):
        """Test basic book creation."""
        book = Book(
            title="Test Book",
            source_path=Path("/test/path"),
            authors=["Test Author"]
        )
        
        assert book.title == "Test Book"
        assert book.primary_author == "Test Author"
        assert book.source_path == Path("/test/path")
        assert book.confidence_score == 0.0  # Default
    
    def test_book_series_detection(self):
        """Test series detection logic."""
        # Test series book
        series_book = Book(
            title="Test Book",
            source_path=Path("/test"),
            series="Test Series",
            series_number=1.0
        )
        
        assert series_book.is_series is False  # Set by post-processing
        assert series_book.formatted_series_number == "1"
        
        # Test decimal series number
        decimal_book = Book(
            title="Test Book",
            source_path=Path("/test"),
            series="Test Series", 
            series_number=1.5
        )
        
        assert decimal_book.formatted_series_number == "1.5"
    
    def test_book_validation(self):
        """Test book validation rules."""
        # Test negative series number validation
        with pytest.raises(ValueError):
            Book(
                title="Test Book",
                source_path=Path("/test"),
                series_number=-1
            )
        
        # Test empty authors defaults to unknown
        book = Book(
            title="Test Book", 
            source_path=Path("/test"),
            authors=[]
        )
        
        assert book.authors == ["Unknown Author"]


class TestScanner:
    """Test metadata scanning functionality."""
    
    def test_scanner_initialization(self):
        """Test scanner can be initialized."""
        config = create_default_config()
        scanner = MetadataScanner(config)
        
        assert scanner.config == config
        assert '.mp3' in scanner.AUDIO_EXTENSIONS
        assert '.jpg' in scanner.IMAGE_EXTENSIONS
    
    def test_clean_title(self):
        """Test title cleaning functionality."""
        config = create_default_config()
        scanner = MetadataScanner(config)
        
        # Test basic cleaning
        assert scanner._clean_title("Test Title (2023)") == "Test Title"
        assert scanner._clean_title("Test Title {Narrator}") == "Test Title"
        assert scanner._clean_title("Test Title - ") == "Test Title"
        assert scanner._clean_title("") == "Unknown Title"
        assert scanner._clean_title(None) == "Unknown Title"
    
    def test_parse_series_from_text(self):
        """Test series parsing from text."""
        config = create_default_config()
        scanner = MetadataScanner(config)
        
        # Test hash pattern
        result = scanner._parse_series_from_text("The Expanse #1")
        assert result is not None
        assert result['series_name'] == "The Expanse"
        assert result['series_number'] == 1.0
        
        # Test book pattern
        result = scanner._parse_series_from_text("Foundation Book 2")
        assert result is not None
        assert result['series_name'] == "Foundation"
        assert result['series_number'] == 2.0
        
        # Test no match
        result = scanner._parse_series_from_text("Just a Regular Title")
        assert result is None


class TestOrganizer:
    """Test organization functionality."""
    
    def test_organizer_initialization(self):
        """Test organizer can be initialized."""
        config = create_default_config()
        organizer = AudiobookOrganizer(config)
        
        assert organizer.config == config
        assert ':' in organizer.CHAR_REPLACEMENTS
    
    def test_clean_directory_name(self):
        """Test directory name cleaning."""
        config = create_default_config()
        organizer = AudiobookOrganizer(config)
        
        # Test basic cleaning
        assert organizer._clean_directory_name("Test: Title") == "Test - Title"
        assert organizer._clean_directory_name("Test?") == "Test"
        assert organizer._clean_directory_name("Test*Name") == "TestxName"
        assert organizer._clean_directory_name("") == "Unknown"
        assert organizer._clean_directory_name(None) == "Unknown"
    
    def test_generate_target_path_series(self):
        """Test target path generation for series books."""
        config = create_default_config()
        config.library_path = Path("/library")
        organizer = AudiobookOrganizer(config)
        
        book = Book(
            title="Test Book",
            source_path=Path("/current"),
            authors=["Test Author"],
            series="Test Series",
            series_number=1.0,
            is_series=True
        )
        
        target = organizer.generate_target_path(book)
        expected = Path("/library/Test Author/Test Series/Test Series - 1")
        
        assert target == expected
    
    def test_generate_target_path_standalone(self):
        """Test target path generation for standalone books."""
        config = create_default_config()
        config.library_path = Path("/library")
        config.prefer_series_structure = False  # Force standalone structure
        organizer = AudiobookOrganizer(config)
        
        book = Book(
            title="Standalone Book",
            source_path=Path("/current"),
            authors=["Test Author"]
        )
        
        target = organizer.generate_target_path(book)
        expected = Path("/library/Test Author/Standalone Book")
        
        assert target == expected


class TestCLIIntegration:
    """Test CLI functionality integration."""
    
    @patch('audioshelf_librarian.main.scan_directory_for_books')
    def test_scan_command_no_books(self, mock_scan):
        """Test scan command when no books are found."""
        mock_scan.return_value = []
        
        # This would normally be tested with CLI runner, but for basic test
        # we just verify the function can be imported and called
        from audioshelf_librarian.main import create_default_config
        
        config = create_default_config()
        assert config is not None
    
    def test_display_functions_exist(self):
        """Test that display functions exist and can be imported."""
        from audioshelf_librarian.main import display_scan_results, display_compliance_report
        
        # These functions exist and can be imported
        assert callable(display_scan_results)
        assert callable(display_compliance_report)


if __name__ == "__main__":
    pytest.main([__file__])
