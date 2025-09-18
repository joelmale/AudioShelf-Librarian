"""
Metadata scanning and extraction module.

This module is like a "detective" that examines audiobook directories and files
to extract metadata from various sources. It follows a priority system:
1. AudioBookShelf metadata.json (most reliable)
2. ID3 tags from audio files (pretty good)
3. Directory/filename parsing (last resort)

The scanner implements the "chain of responsibility" pattern - each method
tries to extract what it can, and we combine the results intelligently.
"""

import json
import re
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
import logging

try:
    from mutagen import File as MutagenFile
    from mutagen.id3 import ID3NoHeaderError
except ImportError:
    MutagenFile = None
    ID3NoHeaderError = Exception

from .models import Book, MetadataSource, Configuration

logger = logging.getLogger(__name__)


class MetadataScanner:
    """
    Main class for extracting audiobook metadata from various sources.
    
    This class acts like a "metadata detective" - it knows how to examine
    different types of clues (JSON files, ID3 tags, filenames) and piece
    together a complete picture of what an audiobook is.
    """
    
    # Common audio file extensions
    AUDIO_EXTENSIONS = {'.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac'}
    
    # Common image extensions for covers
    IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
    
    # Regex patterns for parsing information from filenames/paths
    PATTERNS = {
        # Book number patterns: "Book 1", "Bk 2", "Vol 3", etc.
        'book_number': re.compile(r'\b(?:book|bk|vol|volume)\.?\s*(\d+(?:\.\d+)?)\b', re.IGNORECASE),
        
        # Series with book number: "Series Name #1", "Series Name - 2"
        'series_with_number': re.compile(r'^(.+?)\s*[#\-]\s*(\d+(?:\.\d+)?)(?:\s|$)', re.IGNORECASE),
        
        # Year in parentheses: "(2023)", "(1999)"
        'year': re.compile(r'\((\d{4})\)'),
        
        # Narrator in curly braces: "{John Smith}"
        'narrator': re.compile(r'\{([^}]+)\}'),
        
        # Author patterns: "AuthorName - Title", "Last, First - Title"
        'author_title': re.compile(r'^([^-]+?)\s*-\s*(.+)$'),
    }
    
    def __init__(self, config: Configuration):
        self.config = config
        
    def scan_directory(self, path: Path) -> Book:
        """
        Scan a directory and extract audiobook metadata.
        
        This is the main entry point - like a "scan button" that examines
        a directory and returns a Book object with all available metadata.
        
        Args:
            path: Path to the directory containing the audiobook
            
        Returns:
            Book object with extracted metadata
        """
        logger.info(f"Scanning directory: {path}")
        
        if not path.exists() or not path.is_dir():
            raise ValueError(f"Path {path} does not exist or is not a directory")
        
        # Initialize book with basic path information
        book = Book(
            title="Unknown Title",
            source_path=path,
            audio_files=self._find_audio_files(path),
            cover_file=self._find_cover_image(path)
        )
        
        # Try each metadata source in priority order
        for source in self.config.metadata_source_priority:
            try:
                if source == MetadataSource.ABS_JSON:
                    metadata = self._scan_from_abs_json(path)
                elif source == MetadataSource.ID3_TAGS:
                    metadata = self._scan_from_id3_tags(book.audio_files)
                elif source == MetadataSource.FILENAME:
                    metadata = self._scan_from_path(path)
                else:
                    continue
                
                if metadata:
                    book = self._merge_metadata(book, metadata, source)
                    logger.debug(f"Extracted metadata from {source.value}: {metadata}")
                    
            except Exception as e:
                logger.warning(f"Failed to extract metadata from {source.value}: {e}")
                continue
        
        # Post-processing
        book = self._post_process_book(book)
        
        logger.info(f"Scan complete for '{book.title}' by {book.primary_author}")
        return book
    
    def _find_audio_files(self, path: Path) -> List[Path]:
        """Find all audio files in the directory and subdirectories."""
        audio_files = []
        
        for file_path in path.rglob('*'):
            if file_path.is_file() and file_path.suffix.lower() in self.AUDIO_EXTENSIONS:
                audio_files.append(file_path)
        
        # Sort audio files naturally (so track1, track2, track10 are in order)
        audio_files.sort(key=lambda x: self._natural_sort_key(x.name))
        
        logger.debug(f"Found {len(audio_files)} audio files in {path}")
        return audio_files
    
    def _find_cover_image(self, path: Path) -> Optional[Path]:
        """Find cover image in the directory."""
        # Common cover image names in priority order
        cover_names = ['cover', 'folder', 'front', 'album', 'artwork']
        
        for cover_name in cover_names:
            for ext in self.IMAGE_EXTENSIONS:
                cover_path = path / f"{cover_name}{ext}"
                if cover_path.exists():
                    return cover_path
        
        # If no standard cover found, look for any image
        for file_path in path.iterdir():
            if file_path.is_file() and file_path.suffix.lower() in self.IMAGE_EXTENSIONS:
                return file_path
        
        return None
    
    def _scan_from_abs_json(self, path: Path) -> Optional[Dict[str, Any]]:
        """
        Extract metadata from AudioBookShelf metadata.json file.
        
        This is the gold standard - AudioBookShelf's own metadata is most reliable
        because it's been curated and verified.
        """
        metadata_file = path / 'metadata.json'
        
        if not metadata_file.exists():
            return None
        
        try:
            with open(metadata_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # AudioBookShelf metadata structure
            metadata = {
                'title': data.get('title', '').replace('_', ' '),
                'authors': data.get('authors', []),
                'narrator': data.get('narrator'),
                'series': data.get('series', []),
                'publisher': data.get('publisher'),
                'published_year': self._parse_year(data.get('publishYear')),
                'isbn': data.get('isbn'),
                'language': data.get('language'),
                'genre': data.get('genre'),
                'description': data.get('description'),
                'confidence_score': 1.0  # Highest confidence for ABS metadata
            }
            
            # Handle series information
            if metadata['series']:
                series_info = metadata['series'][0] if isinstance(metadata['series'], list) else metadata['series']
                if isinstance(series_info, dict):
                    metadata['series_name'] = series_info.get('name')
                    metadata['series_number'] = series_info.get('sequence')
                else:
                    metadata['series_name'] = str(series_info)
            
            return metadata
            
        except Exception as e:
            logger.error(f"Failed to parse metadata.json in {path}: {e}")
            return None
    
    def _scan_from_id3_tags(self, audio_files: List[Path]) -> Optional[Dict[str, Any]]:
        """
        Extract metadata from ID3 tags in audio files.
        
        This is our second-best source - ID3 tags are usually reliable
        but might be inconsistent across files or missing some fields.
        """
        if not audio_files or not MutagenFile:
            return None
        
        # Use the first audio file for metadata (they should be consistent)
        first_file = audio_files[0]
        
        try:
            audio_file = MutagenFile(first_file)
            if not audio_file:
                return None
            
            # Extract common ID3 tags
            metadata = {
                'title': self._get_tag_value(audio_file, ['TIT2', 'TALB', 'title', 'album']),
                'authors': self._get_artist_tags(audio_file),
                'narrator': self._get_tag_value(audio_file, ['TCOM', 'composer']),
                'genre': self._get_tag_value(audio_file, ['TCON', 'genre']),
                'published_year': self._parse_year(self._get_tag_value(audio_file, ['TDRC', 'date', 'year'])),
                'publisher': self._get_tag_value(audio_file, ['TPUB', 'publisher']),
                'confidence_score': 0.8  # High confidence for ID3 tags
            }
            
            # Try to extract series information from album or comment tags
            album = self._get_tag_value(audio_file, ['TALB', 'album'])
            if album:
                series_info = self._parse_series_from_text(album)
                if series_info:
                    metadata.update(series_info)
            
            # Calculate duration from all audio files
            total_duration = 0
            for audio_path in audio_files:
                try:
                    af = MutagenFile(audio_path)
                    if af and hasattr(af, 'info') and hasattr(af.info, 'length'):
                        total_duration += af.info.length
                except:
                    continue
            
            if total_duration > 0:
                metadata['duration'] = total_duration
            
            return metadata
            
        except Exception as e:
            logger.warning(f"Failed to extract ID3 tags from {first_file}: {e}")
            return None
    
    def _scan_from_path(self, path: Path) -> Optional[Dict[str, Any]]:
        """
        Extract metadata by parsing directory and file names.
        
        This is our fallback method - parsing filenames is unreliable but
        better than nothing. We use heuristics and regex patterns to guess
        the structure.
        """
        try:
            # Start with the directory name
            dir_name = path.name
            parent_name = path.parent.name if path.parent.name != path.parts[-2] else None
            
            metadata = {
                'title': dir_name,
                'confidence_score': 0.3  # Low confidence for filename parsing
            }
            
            # Try to parse author from parent directory (common pattern: Author/Book)
            if parent_name and parent_name not in ['audiobooks', 'Audiobooks', 'books']:
                # Check if parent looks like an author name
                if not any(char.isdigit() for char in parent_name):  # Authors usually don't have numbers
                    metadata['authors'] = [parent_name]
            
            # Look for series and book number patterns
            series_info = self._parse_series_from_text(dir_name)
            if series_info:
                metadata.update(series_info)
            
            # Look for year in directory name
            year_match = self.PATTERNS['year'].search(dir_name)
            if year_match:
                metadata['published_year'] = int(year_match.group(1))
            
            # Look for narrator in curly braces
            narrator_match = self.PATTERNS['narrator'].search(dir_name)
            if narrator_match:
                metadata['narrator'] = narrator_match.group(1).strip()
                # Remove narrator from title
                metadata['title'] = self.PATTERNS['narrator'].sub('', dir_name).strip()
            
            # Look for author-title pattern in directory name
            author_title_match = self.PATTERNS['author_title'].search(dir_name)
            if author_title_match and 'authors' not in metadata:
                metadata['authors'] = [author_title_match.group(1).strip()]
                metadata['title'] = author_title_match.group(2).strip()
            
            # Clean up the title
            metadata['title'] = self._clean_title(metadata['title'])
            
            return metadata
            
        except Exception as e:
            logger.warning(f"Failed to parse metadata from path {path}: {e}")
            return None
    
    def _parse_series_from_text(self, text: str) -> Optional[Dict[str, Any]]:
        """Parse series name and number from text."""
        # Try series with hash pattern: "Series Name #1"
        hash_match = self.PATTERNS['series_with_number'].search(text)
        if hash_match:
            return {
                'series_name': hash_match.group(1).strip(),
                'series_number': float(hash_match.group(2))
            }
        
        # Try book number pattern: "Book 1", "Vol 2"
        book_match = self.PATTERNS['book_number'].search(text)
        if book_match:
            # If we found a book number, assume the rest is the series name
            series_name = self.PATTERNS['book_number'].sub('', text).strip()
            if series_name:
                return {
                    'series_name': series_name,
                    'series_number': float(book_match.group(1))
                }
        
        return None
    
    def _merge_metadata(self, book: Book, metadata: Dict[str, Any], source: MetadataSource) -> Book:
        """
        Merge new metadata into the existing book object.
        
        This implements a "best available information" strategy - we keep
        the most reliable data we have, but fill in gaps with new information.
        """
        # Only update fields that are better than what we have
        current_confidence = book.confidence_score
        new_confidence = metadata.get('confidence_score', 0.0)
        
        # Always update if this is higher confidence, or if current field is empty
        def should_update(field_name: str) -> bool:
            current_value = getattr(book, field_name, None)
            return (new_confidence > current_confidence or 
                    not current_value or 
                    current_value in ['Unknown Title', 'Unknown Author'])
        
        if metadata.get('title') and should_update('title'):
            book.title = metadata['title']
        
        if metadata.get('authors') and should_update('authors'):
            if isinstance(metadata['authors'], list):
                book.authors = metadata['authors']
            else:
                book.authors = [str(metadata['authors'])]
        
        if metadata.get('series_name') and should_update('series'):
            book.series = metadata['series_name']
            book.is_series = True
        
        if metadata.get('series_number') and should_update('series_number'):
            book.series_number = float(metadata['series_number'])
            book.is_series = True
        
        # Update other fields if available
        for field in ['narrator', 'publisher', 'published_year', 'isbn', 'language', 'genre', 'description', 'duration']:
            if metadata.get(field) and should_update(field):
                setattr(book, field, metadata[field])
        
        # Update metadata tracking
        if new_confidence > current_confidence:
            book.metadata_source = source
            book.confidence_score = new_confidence
        
        return book
    
    def _post_process_book(self, book: Book) -> Book:
        """
        Post-process the book object to clean up and validate data.
        
        This is like a "quality control" step that ensures the data
        makes sense and is properly formatted.
        """
        # Ensure we have at least one author
        if not book.authors:
            book.authors = ["Unknown Author"]
        
        # Clean up title
        if book.title:
            book.title = self._clean_title(book.title)
        
        # Determine if this is part of a series
        book.is_series = bool(book.series and book.series_number)
        
        # Set needs_processing flag based on current location
        book.needs_processing = self._needs_organization(book)
        
        return book
    
    def _needs_organization(self, book: Book) -> bool:
        """
        Determine if a book needs to be reorganized.
        
        This compares the current location with where the book should be
        according to our naming conventions.
        """
        # This will be implemented with the organizer module
        # For now, assume all books need processing
        return True
    
    def _clean_title(self, title: str) -> str:
        """Clean up a title string."""
        if not title:
            return "Unknown Title"
        
        # Remove common unwanted patterns
        title = re.sub(r'\s*\([^)]*\)\s*$', '', title)  # Remove trailing parentheses
        title = re.sub(r'\s*\{[^}]*\}\s*$', '', title)  # Remove trailing curly braces
        title = re.sub(r'\s*[-_]\s*$', '', title)       # Remove trailing dashes/underscores
        title = re.sub(r'\s+', ' ', title)              # Normalize whitespace
        
        return title.strip()
    
    def _get_tag_value(self, audio_file, tag_names: List[str]) -> Optional[str]:
        """Get the first available tag value from a list of possible tag names."""
        if not audio_file:
            return None
            
        for tag_name in tag_names:
            try:
                if hasattr(audio_file, 'tags') and audio_file.tags:
                    # Handle ID3 tags
                    if tag_name in audio_file.tags:
                        value = audio_file.tags[tag_name]
                        if hasattr(value, 'text'):
                            return str(value.text[0]) if value.text else None
                        return str(value)
                
                # Handle other formats (MP4, FLAC, etc.)
                if hasattr(audio_file, tag_name):
                    value = getattr(audio_file, tag_name)
                    if isinstance(value, list) and value:
                        return str(value[0])
                    return str(value) if value else None
                    
            except (AttributeError, KeyError, IndexError):
                continue
        
        return None
    
    def _get_artist_tags(self, audio_file) -> List[str]:
        """Extract artist information from various tag formats."""
        artists = []
        
        # Try different artist tag names
        artist_tags = ['TPE1', 'TPE2', 'artist', 'albumartist', 'performer']
        
        for tag_name in artist_tags:
            value = self._get_tag_value(audio_file, [tag_name])
            if value:
                # Split on common separators
                for separator in [';', '&', ',', ' and ', ' & ']:
                    if separator in value:
                        artists.extend([a.strip() for a in value.split(separator) if a.strip()])
                        break
                else:
                    artists.append(value.strip())
                break
        
        return artists if artists else []
    
    def _parse_year(self, year_value) -> Optional[int]:
        """Parse year from various formats."""
        if not year_value:
            return None
            
        try:
            # Handle string representations
            if isinstance(year_value, str):
                # Extract 4-digit year from string
                year_match = re.search(r'(\d{4})', year_value)
                if year_match:
                    return int(year_match.group(1))
            
            # Handle numeric values
            year_int = int(float(str(year_value)))
            if 1800 <= year_int <= 2100:  # Reasonable year range
                return year_int
                
        except (ValueError, TypeError):
            pass
            
        return None
    
    def _natural_sort_key(self, text: str) -> List:
        """
        Generate a key for natural sorting (handles numbers in strings properly).
        
        This ensures that "track1, track2, track10" sorts correctly instead of
        "track1, track10, track2" which would happen with regular string sorting.
        """
        def convert(text_part):
            return int(text_part) if text_part.isdigit() else text_part.lower()
        
        return [convert(c) for c in re.split('([0-9]+)', text)]


def scan_directory_for_books(path: Path, config: Configuration) -> List[Book]:
    """
    Convenience function to scan a directory for multiple audiobooks.
    
    This handles the common case where a directory contains multiple
    audiobook subdirectories that each need to be scanned.
    
    Args:
        path: Path to scan for audiobook directories
        config: Configuration object
        
    Returns:
        List of Book objects found
    """
    scanner = MetadataScanner(config)
    books = []
    
    if not path.exists() or not path.is_dir():
        logger.error(f"Path {path} does not exist or is not a directory")
        return books
    
    # Look for subdirectories that might contain audiobooks
    for item in path.iterdir():
        if item.is_dir() and not item.name.startswith('.'):
            try:
                # Check if this directory contains audio files
                audio_files = []
                for file_path in item.rglob('*'):
                    if file_path.is_file() and file_path.suffix.lower() in scanner.AUDIO_EXTENSIONS:
                        audio_files.append(file_path)
                
                if audio_files:
                    book = scanner.scan_directory(item)
                    books.append(book)
                    logger.info(f"Found audiobook: {book.title} by {book.primary_author}")
                    
            except Exception as e:
                logger.error(f"Failed to scan directory {item}: {e}")
                continue
    
    logger.info(f"Scan complete: found {len(books)} audiobooks in {path}")
    return books
