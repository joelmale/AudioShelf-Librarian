"""
Audiobook organization and path generation module.

This module contains the core business logic for organizing audiobooks according
to AudioBookShelf conventions. It's like an "architect" that knows how to design
the perfect directory structure for any given book.

The organizer follows the AudioBookShelf specification and generates target paths
based on whether a book is part of a series or standalone, while respecting
user preferences for naming conventions.
"""

import re
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
import logging

from .models import Book, OrganizationAction, ActionType, Configuration

logger = logging.getLogger(__name__)


class AudiobookOrganizer:
    """
    Main class for organizing audiobooks according to AudioBookShelf conventions.
    
    This class acts like a "filing system expert" - it knows the rules for
    where books should go and can generate the proper directory structure
    for any audiobook based on its metadata.
    """
    
    # Characters that are not allowed in file/directory names
    INVALID_CHARS = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
    
    # Safe replacements for invalid characters
    CHAR_REPLACEMENTS = {
        ':': ' -',        # "Title: Subtitle" → "Title - Subtitle"
        '?': '',          # Remove question marks
        '"': "'",         # Use single quotes instead of double
        '*': 'x',         # Replace asterisks with x
        '<': '(',         # Replace angle brackets with parentheses
        '>': ')',
        '|': '-',         # Replace pipes with dashes
    }
    
    def __init__(self, config: Configuration):
        self.config = config
    
    def organize_book(self, book: Book) -> OrganizationAction:
        """
        Generate an organization action for a book.
        
        This is the main entry point - like a "filing decision" that determines
        where a book should go and what needs to be done to get it there.
        
        Args:
            book: Book object to organize
            
        Returns:
            OrganizationAction describing what should be done
        """
        logger.info(f"Organizing book: {book.title} by {book.primary_author}")
        
        try:
            # Generate the target path according to conventions
            target_path = self.generate_target_path(book)
            
            # Determine what action is needed
            action_type = self._determine_action_type(book.source_path, target_path)
            
            # Generate human-readable reason
            reason = self._generate_action_reason(book, action_type, target_path)
            
            action = OrganizationAction(
                book=book,
                action_type=action_type,
                source_path=book.source_path,
                target_path=target_path,
                reason=reason
            )
            
            logger.info(f"Organization plan: {action_type.value} from {book.source_path} to {target_path}")
            return action
            
        except Exception as e:
            logger.error(f"Failed to organize book {book.title}: {e}")
            return OrganizationAction(
                book=book,
                action_type=ActionType.ERROR,
                source_path=book.source_path,
                target_path=book.source_path,
                reason=f"Error organizing book: {str(e)}",
                error_message=str(e)
            )
    
    def generate_target_path(self, book: Book) -> Path:
        """
        Generate the target path for a book according to AudioBookShelf conventions.
        
        This implements the "directory architecture" - it knows the rules for
        how to structure directories based on whether a book is part of a series,
        standalone, etc.
        
        Args:
            book: Book object to generate path for
            
        Returns:
            Path object representing where the book should be located
        """
        # Start with the library root
        library_path = self.config.library_path
        
        # Clean the author name for use in directory structure
        author = self._clean_directory_name(book.primary_author)
        
        # Determine if this should use series structure
        use_series_structure = (
            self.config.prefer_series_structure and 
            book.is_series and 
            book.series and 
            book.series_number is not None
        )
        
        if use_series_structure:
            # Series structure: Author/Series/Series - BookNumber
            series_name = self._clean_directory_name(book.series)
            book_folder = self._generate_series_book_folder_name(book)
            target_path = library_path / author / series_name / book_folder
        else:
            # Standalone structure: Author/Title
            title_folder = self._generate_standalone_folder_name(book)
            target_path = library_path / author / title_folder
        
        logger.debug(f"Generated target path for '{book.title}': {target_path}")
        return target_path
    
    def _generate_series_book_folder_name(self, book: Book) -> str:
        """
        Generate folder name for a book in a series.
        
        Format: "{Series Name} - {Book Number}"
        Example: "The Expanse - 1"
        """
        series_name = self._clean_directory_name(book.series)
        book_number = book.formatted_series_number
        
        folder_name = f"{series_name} - {book_number}"
        
        # Add optional components based on configuration
        if self.config.include_year_in_titles and book.published_year:
            folder_name += f" ({book.published_year})"
        
        if self.config.include_narrator_in_names and book.narrator:
            narrator = self._clean_directory_name(book.narrator)
            folder_name += f" {{{narrator}}}"
        
        return folder_name
    
    def _generate_standalone_folder_name(self, book: Book) -> str:
        """
        Generate folder name for a standalone book.
        
        Format: "{Title}" or "{Title} ({Year})" or "{Title} {Narrator}"
        """
        title = self._clean_directory_name(book.title)
        
        # Add optional components based on configuration
        if self.config.include_year_in_titles and book.published_year:
            title += f" ({book.published_year})"
        
        if self.config.include_narrator_in_names and book.narrator:
            narrator = self._clean_directory_name(book.narrator)
            title += f" {{{narrator}}}"
        
        return title
    
    def _clean_directory_name(self, name: str) -> str:
        """
        Clean a string to be safe for use as a directory name.
        
        This removes or replaces characters that would cause problems
        in file systems. It's like a "sanitizer" for directory names.
        """
        if not name:
            return "Unknown"
        
        # Replace invalid characters
        cleaned = name
        for invalid_char, replacement in self.CHAR_REPLACEMENTS.items():
            cleaned = cleaned.replace(invalid_char, replacement)
        
        # Remove any remaining invalid characters
        for char in self.INVALID_CHARS:
            cleaned = cleaned.replace(char, '')
        
        # Clean up whitespace and formatting
        cleaned = re.sub(r'\s+', ' ', cleaned)  # Normalize whitespace
        cleaned = cleaned.strip()               # Remove leading/trailing spaces
        cleaned = cleaned.strip('.-_')          # Remove trailing punctuation
        
        # Ensure the name isn't empty
        if not cleaned:
            return "Unknown"
        
        # Truncate if too long (most file systems have 255 char limit)
        if len(cleaned) > 200:
            cleaned = cleaned[:200].strip()
        
        return cleaned
    
    def _determine_action_type(self, source_path: Path, target_path: Path) -> ActionType:
        """
        Determine what type of action is needed to organize a book.
        
        This compares where the book is now with where it should be
        and decides what operation is needed.
        """
        # Normalize paths for comparison
        source_resolved = source_path.resolve()
        target_resolved = target_path.resolve()
        
        if source_resolved == target_resolved:
            return ActionType.SKIP  # Already in the right place
        
        # Check if target directory already exists
        if target_path.exists():
            logger.warning(f"Target path already exists: {target_path}")
            return ActionType.ERROR  # Conflict - target exists
        
        # Check if we're just renaming in the same parent directory
        if source_path.parent == target_path.parent:
            return ActionType.RENAME
        
        # Otherwise, we need to move to a different location
        return ActionType.MOVE
    
    def _generate_action_reason(self, book: Book, action_type: ActionType, target_path: Path) -> str:
        """Generate a human-readable explanation for why this action is needed."""
        if action_type == ActionType.SKIP:
            return "Book is already properly organized"
        
        if action_type == ActionType.ERROR:
            if target_path.exists():
                return f"Target directory already exists: {target_path.name}"
            return "Unable to determine organization action"
        
        if action_type == ActionType.RENAME:
            return f"Rename to follow AudioBookShelf naming convention: {target_path.name}"
        
        if action_type == ActionType.MOVE:
            reason_parts = []
            
            # Explain the organizational structure being applied
            if book.is_series:
                reason_parts.append(f"Organize into series structure: {book.primary_author}/{book.series}")
            else:
                reason_parts.append(f"Organize into author structure: {book.primary_author}")
            
            # Explain specific naming conventions applied
            if book.is_series and book.series_number:
                reason_parts.append(f"Apply series naming: {book.series} - {book.formatted_series_number}")
            
            return " | ".join(reason_parts)
        
        return f"Perform {action_type.value} operation"
    
    def validate_organization_compliance(self, book: Book) -> Dict[str, Any]:
        """
        Validate if a book's current location complies with AudioBookShelf conventions.
        
        This is like a "quality inspector" that checks if a book is already
        properly organized according to our standards.
        
        Returns:
            Dictionary with compliance information and suggestions
        """
        target_path = self.generate_target_path(book)
        current_path = book.source_path
        
        compliance = {
            'is_compliant': current_path.resolve() == target_path.resolve(),
            'current_path': str(current_path),
            'expected_path': str(target_path),
            'issues': [],
            'suggestions': []
        }
        
        if not compliance['is_compliant']:
            # Analyze what's wrong and provide specific feedback
            compliance['issues'] = self._analyze_compliance_issues(book, current_path, target_path)
            compliance['suggestions'] = self._generate_compliance_suggestions(book, current_path, target_path)
        
        return compliance
    
    def _analyze_compliance_issues(self, book: Book, current_path: Path, target_path: Path) -> List[str]:
        """Analyze specific compliance issues with current organization."""
        issues = []
        
        current_parts = current_path.parts
        target_parts = target_path.parts
        
        # Check author directory structure
        if len(current_parts) >= 2 and len(target_parts) >= 2:
            current_author = current_parts[-2] if len(current_parts) > 1 else ""
            target_author = target_parts[-2] if len(target_parts) > 1 else ""
            
            if current_author != target_author:
                issues.append(f"Author directory mismatch: '{current_author}' should be '{target_author}'")
        
        # Check series structure
        if book.is_series:
            if len(current_parts) < len(target_parts):
                issues.append("Missing series directory level")
            elif len(current_parts) >= 3 and len(target_parts) >= 3:
                current_series = current_parts[-3] if len(current_parts) > 2 else ""
                target_series = target_parts[-3] if len(target_parts) > 2 else ""
                
                if current_series != target_series:
                    issues.append(f"Series directory mismatch: '{current_series}' should be '{target_series}'")
        
        # Check book folder naming
        current_folder = current_path.name
        target_folder = target_path.name
        
        if current_folder != target_folder:
            issues.append(f"Book folder naming: '{current_folder}' should be '{target_folder}'")
        
        return issues
    
    def _generate_compliance_suggestions(self, book: Book, current_path: Path, target_path: Path) -> List[str]:
        """Generate suggestions for improving compliance."""
        suggestions = []
        
        if book.is_series:
            suggestions.append(f"Use series structure: Author/{book.series}/BookFolder")
            if book.series_number:
                suggestions.append(f"Include book number in folder name: {book.series} - {book.formatted_series_number}")
        else:
            suggestions.append("Use standalone structure: Author/Title")
        
        if self.config.include_year_in_titles and book.published_year:
            suggestions.append(f"Consider including publication year: ({book.published_year})")
        
        if self.config.include_narrator_in_names and book.narrator:
            suggestions.append(f"Consider including narrator: {{{book.narrator}}}")
        
        return suggestions


class LibraryOrganizer:
    """
    High-level organizer that manages multiple books and batch operations.
    
    This class acts like a "library manager" - it can organize entire
    collections of books and coordinate complex operations across many files.
    """
    
    def __init__(self, config: Configuration):
        self.config = config
        self.book_organizer = AudiobookOrganizer(config)
    
    def organize_library(self, books: List[Book]) -> List[OrganizationAction]:
        """
        Generate organization actions for a list of books.
        
        This is the "batch processor" - it can handle organizing many books
        at once and returns a comprehensive plan for the entire operation.
        
        Args:
            books: List of Book objects to organize
            
        Returns:
            List of OrganizationAction objects describing what needs to be done
        """
        logger.info(f"Organizing {len(books)} books")
        
        actions = []
        conflicts = {}
        
        for book in books:
            try:
                action = self.book_organizer.organize_book(book)
                
                # Check for conflicts (multiple books targeting the same location)
                target_str = str(action.target_path)
                if target_str in conflicts:
                    # Mark both actions as errors due to conflict
                    original_action = conflicts[target_str]
                    original_action.action_type = ActionType.ERROR
                    original_action.reason = f"Conflict: Multiple books target same location: {target_str}"
                    
                    action.action_type = ActionType.ERROR
                    action.reason = f"Conflict: Multiple books target same location: {target_str}"
                else:
                    conflicts[target_str] = action
                
                actions.append(action)
                
            except Exception as e:
                logger.error(f"Failed to organize book {book.title}: {e}")
                error_action = OrganizationAction(
                    book=book,
                    action_type=ActionType.ERROR,
                    source_path=book.source_path,
                    target_path=book.source_path,
                    reason=f"Error: {str(e)}",
                    error_message=str(e)
                )
                actions.append(error_action)
        
        # Log summary
        action_counts = {}
        for action in actions:
            action_type = action.action_type
            action_counts[action_type] = action_counts.get(action_type, 0) + 1
        
        logger.info(f"Organization plan complete: {action_counts}")
        return actions
    
    def validate_library_compliance(self, books: List[Book]) -> Dict[str, Any]:
        """
        Validate compliance of an entire library.
        
        This provides a "library report card" - it tells you how well
        your entire collection follows AudioBookShelf conventions.
        
        Returns:
            Dictionary with overall compliance metrics and detailed results
        """
        total_books = len(books)
        compliant_books = 0
        all_issues = []
        all_suggestions = []
        
        detailed_results = []
        
        for book in books:
            try:
                compliance = self.book_organizer.validate_organization_compliance(book)
                detailed_results.append({
                    'book': book,
                    'compliance': compliance
                })
                
                if compliance['is_compliant']:
                    compliant_books += 1
                else:
                    all_issues.extend(compliance['issues'])
                    all_suggestions.extend(compliance['suggestions'])
                    
            except Exception as e:
                logger.error(f"Failed to validate compliance for {book.title}: {e}")
                detailed_results.append({
                    'book': book,
                    'compliance': {
                        'is_compliant': False,
                        'issues': [f"Validation error: {str(e)}"],
                        'suggestions': []
                    }
                })
        
        # Calculate overall metrics
        compliance_rate = (compliant_books / total_books) if total_books > 0 else 0.0
        
        # Count unique issues and suggestions
        unique_issues = list(set(all_issues))
        unique_suggestions = list(set(all_suggestions))
        
        return {
            'total_books': total_books,
            'compliant_books': compliant_books,
            'non_compliant_books': total_books - compliant_books,
            'compliance_rate': compliance_rate,
            'common_issues': unique_issues,
            'recommendations': unique_suggestions,
            'detailed_results': detailed_results
        }
    
    def preview_organization(self, books: List[Book]) -> Dict[str, Any]:
        """
        Generate a preview of what organization would do without executing.
        
        This is the "dry run" feature - it shows you exactly what would
        happen if you organized your library, but doesn't actually do it.
        
        Returns:
            Dictionary with preview information and statistics
        """
        actions = self.organize_library(books)
        
        # Calculate statistics
        stats = {
            'total_books': len(books),
            'books_to_move': 0,
            'books_to_rename': 0,
            'books_already_organized': 0,
            'books_with_errors': 0,
            'actions_by_type': {},
            'estimated_operations': 0
        }
        
        for action in actions:
            action_type = action.action_type
            stats['actions_by_type'][action_type.value] = stats['actions_by_type'].get(action_type.value, 0) + 1
            
            if action_type == ActionType.MOVE:
                stats['books_to_move'] += 1
                stats['estimated_operations'] += 1
            elif action_type == ActionType.RENAME:
                stats['books_to_rename'] += 1
                stats['estimated_operations'] += 1
            elif action_type == ActionType.SKIP:
                stats['books_already_organized'] += 1
            elif action_type == ActionType.ERROR:
                stats['books_with_errors'] += 1
        
        return {
            'actions': actions,
            'statistics': stats,
            'safe_to_execute': stats['books_with_errors'] == 0,
            'preview_timestamp': logger.handlers[0].formatter.converter() if logger.handlers else None
        }


def organize_single_book(book: Book, config: Configuration) -> OrganizationAction:
    """
    Convenience function to organize a single book.
    
    This is a simple wrapper for the common case where you just want
    to organize one book without dealing with the full organizer class.
    
    Args:
        book: Book object to organize
        config: Configuration object
        
    Returns:
        OrganizationAction describing what should be done
    """
    organizer = AudiobookOrganizer(config)
    return organizer.organize_book(book)


def generate_audiobookshelf_path(book: Book, config: Configuration) -> Path:
    """
    Convenience function to generate just the target path for a book.
    
    This is useful when you just want to know where a book should go
    without creating a full organization action.
    
    Args:
        book: Book object
        config: Configuration object
        
    Returns:
        Path object representing where the book should be located
    """
    organizer = AudiobookOrganizer(config)
    return organizer.generate_target_path(book)
