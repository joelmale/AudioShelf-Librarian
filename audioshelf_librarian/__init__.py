"""
AudioShelf Librarian - A tool for organizing audiobook libraries.

This package provides tools for organizing audiobook collections according to
AudioBookShelf conventions. It can scan directories, extract metadata from
various sources, and reorganize files into proper directory structures.
"""

__version__ = "1.0.0"
__author__ = "AudioShelf Librarian Project"
__description__ = "A tool for organizing audiobook libraries according to AudioBookShelf conventions"

# Import main classes for convenient access
from .models import Book, Configuration, OrganizationAction, ScanResult
from .scanner import MetadataScanner, scan_directory_for_books
from .organizer import AudiobookOrganizer, LibraryOrganizer
from .parallel import ParallelProcessor, PerformanceMonitor, ProgressTracker, create_parallel_processor, scan_directory_for_books_parallel
from .scan_strategies import ScanStrategy, ScanOrder, ScanProgress

__all__ = [
    "Book",
    "Configuration", 
    "OrganizationAction",
    "ScanResult",
    "MetadataScanner",
    "scan_directory_for_books",
    "AudiobookOrganizer",
    "LibraryOrganizer",
    "ParallelProcessor",
    "PerformanceMonitor",
    "ProgressTracker",
    "create_parallel_processor",
    "scan_directory_for_books_parallel",
    "ScanStrategy",
    "ScanOrder",
    "ScanProgress"
]
