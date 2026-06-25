"""
Data models for AudioShelf Librarian.

This module defines the core data structures used throughout the application.
Think of these as the "vocabulary" or "blueprint" that defines how we represent
audiobooks in memory - similar to how a database schema defines table structure.
"""

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, validator


class MetadataSource(str, Enum):
    """
    Enumeration of metadata sources in order of preference.
    
    This is like a hierarchy of trust - we prefer AudioBookShelf's own
    metadata.json (most reliable), then ID3 tags (pretty good), then
    filename parsing (last resort).
    """
    ABS_JSON = "abs_json"      # AudioBookShelf metadata.json
    ID3_TAGS = "id3_tags"      # Audio file ID3/metadata tags  
    FILENAME = "filename"      # Parsed from directory/file names
    MANUAL = "manual"          # Manually entered/corrected


class ActionType(str, Enum):
    """Types of operations that can be performed on audiobook files."""
    MOVE = "move"              # Move files to new location
    RENAME = "rename"          # Rename in current location
    COPY = "copy"              # Copy files (for dry run safety)
    SKIP = "skip"              # No action needed
    ERROR = "error"            # Cannot process due to error


class Book(BaseModel):
    """
    Core data model representing an audiobook.
    
    This is the central "citizen" of our application - every audiobook
    gets represented as a Book object. It's like a standardized form
    that captures all the important information about a book regardless
    of where that information came from.
    
    The model follows the principle of "capture everything, decide later" -
    we store all available metadata and let other parts of the system
    decide what to use.
    """
    
    # Core identification
    title: str = Field(..., description="Book title")
    authors: List[str] = Field(default_factory=list, description="List of authors")
    
    # Series information
    series: Optional[str] = Field(None, description="Series name")
    series_number: Optional[float] = Field(None, description="Book number in series")
    
    # Additional metadata
    narrator: Optional[str] = Field(None, description="Narrator/reader")
    publisher: Optional[str] = Field(None, description="Publisher")
    published_year: Optional[int] = Field(None, description="Publication year")
    isbn: Optional[str] = Field(None, description="ISBN")
    language: Optional[str] = Field(None, description="Language code")
    genre: Optional[str] = Field(None, description="Primary genre")
    description: Optional[str] = Field(None, description="Book description")
    duration: Optional[float] = Field(None, description="Duration in seconds")
    
    # File system information
    source_path: Path = Field(..., description="Current path to the book files")
    audio_files: List[Path] = Field(default_factory=list, description="List of audio files")
    cover_file: Optional[Path] = Field(None, description="Path to cover image")
    
    # Metadata tracking
    metadata_source: MetadataSource = Field(MetadataSource.FILENAME, description="Source of this metadata")
    confidence_score: float = Field(0.0, description="Confidence in metadata accuracy (0.0-1.0)")
    
    # ABS server identity — populated when items come from the ABS API.
    # Having these IDs lets subsequent operations (e.g. rescan triggers,
    # metadata patches) reference the correct ABS library item without an
    # additional lookup.
    abs_item_id: Optional[str] = Field(None, description="ABS library item ID (from /api/libraries/{id}/items)")
    abs_library_id: Optional[str] = Field(None, description="ABS library ID this item belongs to")

    # Processing state
    is_series: bool = Field(False, description="Whether this is part of a series")
    needs_processing: bool = Field(True, description="Whether this book needs organization")
    
    class Config:
        # Allow Path objects in Pydantic model
        arbitrary_types_allowed = True
        
    @validator('series_number')
    def validate_series_number(cls, v):
        """Ensure series number is positive if provided."""
        if v is not None and v <= 0:
            raise ValueError("Series number must be positive")
        return v
    
    @validator('authors')
    def validate_authors(cls, v):
        """Ensure at least one author or set default."""
        if not v:
            return ["Unknown Author"]
        return v
    
    @property
    def primary_author(self) -> str:
        """Get the primary (first) author."""
        return self.authors[0] if self.authors else "Unknown Author"
    
    @property
    def formatted_series_number(self) -> str:
        """Format series number for display (remove .0 from whole numbers)."""
        if self.series_number is None:
            return ""
        if self.series_number == int(self.series_number):
            return str(int(self.series_number))
        return str(self.series_number)
    
    @property
    def is_standalone(self) -> bool:
        """Check if this is a standalone book (not part of a series)."""
        return not self.is_series or not self.series


class OrganizationAction(BaseModel):
    """
    Represents a proposed action to organize a book.
    
    This is like a "work order" - it describes what needs to be done
    to move a book from its current location to where it should be
    according to AudioBookShelf conventions.
    """
    
    book: Book = Field(..., description="The book to be organized")
    action_type: ActionType = Field(..., description="Type of action to perform")
    source_path: Path = Field(..., description="Current location")
    target_path: Path = Field(..., description="Proposed new location")
    reason: str = Field(..., description="Human-readable reason for this action")
    
    # Execution tracking
    executed: bool = Field(False, description="Whether this action has been executed")
    execution_time: Optional[datetime] = Field(None, description="When this action was executed")
    success: bool = Field(False, description="Whether execution was successful")
    error_message: Optional[str] = Field(None, description="Error message if execution failed")
    
    class Config:
        arbitrary_types_allowed = True
    
    @property
    def will_change_location(self) -> bool:
        """Check if this action will actually change the file location."""
        return self.source_path != self.target_path and self.action_type in (ActionType.MOVE, ActionType.RENAME)


class ScanResult(BaseModel):
    """
    Results from scanning a directory for audiobooks.
    
    This aggregates the results of scanning operations - like a "report card"
    that tells us what we found and what needs to be done.
    """
    
    scanned_path: Path = Field(..., description="The path that was scanned")
    books_found: List[Book] = Field(default_factory=list, description="Books discovered")
    actions_proposed: List[OrganizationAction] = Field(default_factory=list, description="Proposed organization actions")
    errors: List[str] = Field(default_factory=list, description="Errors encountered during scanning")
    
    scan_time: datetime = Field(default_factory=datetime.now, description="When the scan was performed")
    
    class Config:
        arbitrary_types_allowed = True
    
    @property
    def total_books(self) -> int:
        """Total number of books found."""
        return len(self.books_found)
    
    @property
    def books_needing_organization(self) -> int:
        """Number of books that need to be moved/renamed."""
        return len([action for action in self.actions_proposed if action.will_change_location])
    
    @property
    def success_rate(self) -> float:
        """Percentage of books successfully processed (0.0 to 1.0)."""
        if not self.books_found:
            return 0.0
        return len(self.books_found) / (len(self.books_found) + len(self.errors))


class TransactionLog(BaseModel):
    """
    Log entry for file operations to enable undo functionality.
    
    This is our "audit trail" - every file operation gets logged here
    so we can reverse it if needed. Think of it like version control
    for file moves.
    """
    
    transaction_id: str = Field(..., description="Unique identifier for this transaction")
    timestamp: datetime = Field(default_factory=datetime.now, description="When the transaction occurred")
    action_type: ActionType = Field(..., description="Type of operation performed")
    
    # File operation details
    original_path: Path = Field(..., description="Original file/directory path")
    new_path: Path = Field(..., description="New file/directory path")
    
    # Metadata for context
    book_title: str = Field(..., description="Title of the book that was moved")
    book_author: str = Field(..., description="Primary author of the book")
    
    # Execution details
    success: bool = Field(..., description="Whether the operation succeeded")
    error_message: Optional[str] = Field(None, description="Error message if operation failed")
    
    class Config:
        arbitrary_types_allowed = True


class Configuration(BaseModel):
    """
    Application configuration settings.
    
    This centralizes all the configurable behavior of the application.
    Think of it as the "control panel" - users can adjust these settings
    to customize how the application behaves.
    """
    
    # Directory paths
    library_path: Path = Field(..., description="Path to the AudioBookShelf library")
    inbox_path: Path = Field(..., description="Path to the inbox directory for new books")
    temp_path: Optional[Path] = Field(None, description="Path for temporary operations")
    
    # Organization preferences  
    prefer_series_structure: bool = Field(True, description="Prefer series-based organization when possible")
    include_year_in_titles: bool = Field(False, description="Include publication year in standalone titles")
    include_narrator_in_names: bool = Field(False, description="Include narrator in directory names")
    
    # Metadata preferences
    metadata_source_priority: List[MetadataSource] = Field(
        default=[MetadataSource.ABS_JSON, MetadataSource.ID3_TAGS, MetadataSource.FILENAME],
        description="Priority order for metadata sources"
    )
    
    # Safety settings
    require_confirmation: bool = Field(True, description="Require user confirmation before executing actions")
    create_backups: bool = Field(True, description="Create backups before destructive operations")
    max_undo_transactions: int = Field(100, description="Maximum number of transactions to keep for undo")
    
    # Processing settings
    scan_subdirectories: bool = Field(True, description="Recursively scan subdirectories")
    skip_hidden_files: bool = Field(True, description="Skip files and directories starting with .")
    minimum_confidence_threshold: float = Field(0.5, description="Minimum confidence to auto-organize")
    
    class Config:
        arbitrary_types_allowed = True
        
    @validator('minimum_confidence_threshold')
    def validate_confidence_threshold(cls, v):
        """Ensure confidence threshold is between 0 and 1."""
        if not 0.0 <= v <= 1.0:
            raise ValueError("Confidence threshold must be between 0.0 and 1.0")
        return v
