"""
Advanced scanning strategies and progress management for AudioShelf Librarian.

This module provides sophisticated scanning options including different ordering
strategies, pause/resume functionality, and progress state management for
handling large audiobook libraries efficiently.
"""

import json
import random
import time
from enum import Enum
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
from dataclasses import dataclass, asdict
import logging

logger = logging.getLogger(__name__)


class ScanOrder(str, Enum):
    """Different strategies for ordering directory scanning."""
    ALPHABETICAL = "alphabetical"    # A-Z order
    REVERSE = "reverse"              # Z-A order  
    RANDOM = "random"                # Random shuffle
    QUARTERS = "quarters"            # Split into 4 parts for incremental processing
    EIGHTHS = "eighths"              # Split into 8 parts for very large libraries
    SIZE_ASCENDING = "size-asc"      # Smallest directories first
    SIZE_DESCENDING = "size-desc"    # Largest directories first
    RECENT_FIRST = "recent"          # Most recently modified first
    OLDEST_FIRST = "oldest"          # Least recently modified first


@dataclass
class ScanProgress:
    """
    State tracking for resumable scanning operations.
    
    This allows users to pause large scanning operations and resume
    them later exactly where they left off.
    """
    
    scan_id: str                    # Unique identifier for this scan session
    total_directories: int          # Total number of directories to scan
    completed_directories: int      # Number already processed
    current_directory: Optional[str] # Directory currently being processed
    scan_order: ScanOrder          # Ordering strategy being used
    start_time: float              # When scanning started
    last_update_time: float        # Last progress update
    
    # Results tracking
    books_found: int = 0           # Total books discovered so far
    directories_processed: List[str] = None  # List of completed directory names
    errors_encountered: List[str] = None     # List of error messages
    
    # Resume information
    resume_point: Optional[str] = None       # Directory name to resume from
    remaining_directories: List[str] = None  # Directories still to process
    
    def __post_init__(self):
        if self.directories_processed is None:
            self.directories_processed = []
        if self.errors_encountered is None:
            self.errors_encountered = []
        if self.remaining_directories is None:
            self.remaining_directories = []
    
    @property
    def progress_percentage(self) -> float:
        """Calculate completion percentage."""
        if self.total_directories == 0:
            return 0.0
        return (self.completed_directories / self.total_directories) * 100
    
    @property
    def elapsed_time(self) -> float:
        """Calculate total elapsed time."""
        return self.last_update_time - self.start_time
    
    @property
    def estimated_time_remaining(self) -> float:
        """Estimate remaining time based on current progress."""
        if self.completed_directories == 0:
            return 0.0
        
        elapsed = self.elapsed_time
        rate = self.completed_directories / elapsed  # directories per second
        remaining = self.total_directories - self.completed_directories
        
        return remaining / rate if rate > 0 else 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ScanProgress':
        """Create from dictionary loaded from JSON."""
        # Convert string enum back to enum
        if 'scan_order' in data and isinstance(data['scan_order'], str):
            data['scan_order'] = ScanOrder(data['scan_order'])
        return cls(**data)


class ScanStrategy:
    """
    Manages different scanning strategies and progress persistence.
    
    This class knows how to order directories for scanning, save/load
    progress state, and resume interrupted operations.
    """
    
    def __init__(self, progress_file: Optional[Path] = None):
        self.progress_file = progress_file or Path(".audioshelf_scan_progress.json")
        
    def order_directories(self, directories: List[Path], scan_order: ScanOrder, resume_from: Optional[str] = None) -> List[Path]:
        """
        Order directories according to the specified strategy.
        
        Args:
            directories: List of directory paths to order
            scan_order: Ordering strategy to use
            resume_from: Directory name to resume from (if any)
            
        Returns:
            Ordered list of directories to scan
        """
        logger.info(f"Ordering {len(directories)} directories using {scan_order.value} strategy")
        
        # Filter out any directories that don't exist
        valid_dirs = [d for d in directories if d.exists() and d.is_dir()]
        
        if len(valid_dirs) != len(directories):
            logger.warning(f"Filtered out {len(directories) - len(valid_dirs)} invalid directories")
        
        # Apply ordering strategy
        if scan_order == ScanOrder.ALPHABETICAL:
            ordered_dirs = sorted(valid_dirs, key=lambda x: x.name.lower())
        
        elif scan_order == ScanOrder.REVERSE:
            ordered_dirs = sorted(valid_dirs, key=lambda x: x.name.lower(), reverse=True)
        
        elif scan_order == ScanOrder.RANDOM:
            ordered_dirs = valid_dirs.copy()
            random.shuffle(ordered_dirs)
            logger.info("Directories randomly shuffled for scanning")
        
        elif scan_order == ScanOrder.QUARTERS:
            ordered_dirs = self._split_into_parts(valid_dirs, 4, "quarters")
        
        elif scan_order == ScanOrder.EIGHTHS:
            ordered_dirs = self._split_into_parts(valid_dirs, 8, "eighths")
        
        elif scan_order == ScanOrder.SIZE_ASCENDING:
            ordered_dirs = self._order_by_size(valid_dirs, ascending=True)
        
        elif scan_order == ScanOrder.SIZE_DESCENDING:
            ordered_dirs = self._order_by_size(valid_dirs, ascending=False)
        
        elif scan_order == ScanOrder.RECENT_FIRST:
            ordered_dirs = self._order_by_modification_time(valid_dirs, recent_first=True)
        
        elif scan_order == ScanOrder.OLDEST_FIRST:
            ordered_dirs = self._order_by_modification_time(valid_dirs, recent_first=False)
        
        else:
            logger.warning(f"Unknown scan order {scan_order}, using alphabetical")
            ordered_dirs = sorted(valid_dirs, key=lambda x: x.name.lower())
        
        # Handle resume point if specified
        if resume_from:
            ordered_dirs = self._apply_resume_point(ordered_dirs, resume_from)
        
        logger.info(f"Directory ordering complete: {len(ordered_dirs)} directories ready for scanning")
        return ordered_dirs
    
    def _split_into_parts(self, directories: List[Path], num_parts: int, part_name: str) -> List[Path]:
        """Split directories into parts for incremental processing."""
        if not directories:
            return directories
        
        # Sort alphabetically first
        sorted_dirs = sorted(directories, key=lambda x: x.name.lower())
        
        # Calculate part size
        part_size = len(sorted_dirs) // num_parts
        remainder = len(sorted_dirs) % num_parts
        
        # For now, return the first part (could be extended to let user choose part)
        first_part_size = part_size + (1 if remainder > 0 else 0)
        first_part = sorted_dirs[:first_part_size]
        
        logger.info(f"Using first quarter: {len(first_part)} directories out of {len(sorted_dirs)}")
        logger.info(f"This represents {(len(first_part)/len(sorted_dirs)*100):.1f}% of your library")
        logger.info(f"To scan other parts, use --scan-order quarters with --resume-from option")
        
        return first_part
    
    def _order_by_size(self, directories: List[Path], ascending: bool = True) -> List[Path]:
        """Order directories by total size."""
        def get_dir_size(directory: Path) -> int:\n            \"\"\"Calculate total size of directory in bytes.\"\"\"\n            total_size = 0\n            try:\n                for file_path in directory.rglob('*'):\n                    if file_path.is_file():\n                        total_size += file_path.stat().st_size\n            except (OSError, PermissionError) as e:\n                logger.warning(f\"Could not calculate size for {directory}: {e}\")\n                return 0\n            return total_size\n        \n        logger.info(f\"Calculating directory sizes for {len(directories)} directories...\")\n        \n        # Calculate sizes and sort\n        dirs_with_sizes = [(d, get_dir_size(d)) for d in directories]\n        sorted_dirs = sorted(dirs_with_sizes, key=lambda x: x[1], reverse=not ascending)\n        \n        ordered_dirs = [d for d, size in sorted_dirs]\n        \n        size_order = \"smallest\" if ascending else \"largest\"\n        logger.info(f\"Directories ordered by size ({size_order} first)\")\n        \n        return ordered_dirs\n    \n    def _order_by_modification_time(self, directories: List[Path], recent_first: bool = True) -> List[Path]:\n        \"\"\"Order directories by modification time.\"\"\"\n        def get_modification_time(directory: Path) -> float:\n            try:\n                return directory.stat().st_mtime\n            except (OSError, PermissionError):\n                return 0.0\n        \n        ordered_dirs = sorted(directories, key=get_modification_time, reverse=recent_first)\n        \n        time_order = \"most recent\" if recent_first else \"oldest\"\n        logger.info(f\"Directories ordered by modification time ({time_order} first)\")\n        \n        return ordered_dirs\n    \n    def _apply_resume_point(self, directories: List[Path], resume_from: str) -> List[Path]:\n        \"\"\"Filter directories to start from resume point.\"\"\"\n        resume_from_lower = resume_from.lower()\n        \n        # Find the index of the resume point\n        resume_index = None\n        for i, directory in enumerate(directories):\n            if directory.name.lower() == resume_from_lower:\n                resume_index = i\n                break\n            # Also try partial matching\n            elif resume_from_lower in directory.name.lower():\n                resume_index = i\n                break\n        \n        if resume_index is not None:\n            resumed_dirs = directories[resume_index:]\n            logger.info(f\"Resuming from '{directories[resume_index].name}' - processing {len(resumed_dirs)} remaining directories\")\n            return resumed_dirs\n        else:\n            logger.warning(f\"Could not find resume point '{resume_from}' - starting from beginning\")\n            return directories\n    \n    def save_progress(self, progress: ScanProgress) -> bool:\n        \"\"\"Save scan progress to file.\"\"\"\n        try:\n            with open(self.progress_file, 'w') as f:\n                json.dump(progress.to_dict(), f, indent=2)\n            logger.info(f\"Progress saved to {self.progress_file}\")\n            return True\n        except Exception as e:\n            logger.error(f\"Failed to save progress: {e}\")\n            return False\n    \n    def load_progress(self, scan_id: Optional[str] = None) -> Optional[ScanProgress]:\n        \"\"\"Load scan progress from file.\"\"\"\n        if not self.progress_file.exists():\n            return None\n        \n        try:\n            with open(self.progress_file, 'r') as f:\n                data = json.load(f)\n            \n            progress = ScanProgress.from_dict(data)\n            \n            # If scan_id is specified, only return matching progress\n            if scan_id and progress.scan_id != scan_id:\n                return None\n            \n            logger.info(f\"Loaded progress: {progress.completed_directories}/{progress.total_directories} directories completed\")\n            return progress\n            \n        except Exception as e:\n            logger.error(f\"Failed to load progress: {e}\")\n            return None\n    \n    def create_scan_id(self, base_path: Path, scan_order: ScanOrder) -> str:\n        \"\"\"Create a unique scan ID based on path and strategy.\"\"\"\n        import hashlib\n        import time\n        \n        # Create ID from path, scan order, and timestamp\n        content = f\"{base_path.absolute()}_{scan_order.value}_{int(time.time())}\"\n        scan_id = hashlib.md5(content.encode()).hexdigest()[:12]\n        \n        return f\"scan_{scan_id}\"\n    \n    def cleanup_old_progress(self, max_age_days: int = 7) -> bool:\n        \"\"\"Remove old progress files.\"\"\"\n        if not self.progress_file.exists():\n            return True\n        \n        try:\n            file_age = time.time() - self.progress_file.stat().st_mtime\n            max_age_seconds = max_age_days * 24 * 3600\n            \n            if file_age > max_age_seconds:\n                self.progress_file.unlink()\n                logger.info(f\"Removed old progress file (age: {file_age/86400:.1f} days)\")\n                return True\n            \n            return False\n            \n        except Exception as e:\n            logger.error(f\"Failed to cleanup old progress: {e}\")\n            return False\n\n\ndef get_scan_order_description(scan_order: ScanOrder) -> str:\n    \"\"\"Get human-readable description of scan order strategy.\"\"\"\n    descriptions = {\n        ScanOrder.ALPHABETICAL: \"Process directories in A-Z order (predictable and systematic)\",\n        ScanOrder.REVERSE: \"Process directories in Z-A order (useful for testing or variety)\",\n        ScanOrder.RANDOM: \"Process directories in random order (good for sampling large libraries)\",\n        ScanOrder.QUARTERS: \"Process first 25% of directories (alphabetically sorted)\",\n        ScanOrder.EIGHTHS: \"Process first 12.5% of directories (for very large libraries)\",\n        ScanOrder.SIZE_ASCENDING: \"Process smallest directories first (faster initial results)\",\n        ScanOrder.SIZE_DESCENDING: \"Process largest directories first (handles big collections early)\",\n        ScanOrder.RECENT_FIRST: \"Process most recently modified directories first\",\n        ScanOrder.OLDEST_FIRST: \"Process oldest directories first\"\n    }\n    \n    return descriptions.get(scan_order, \"Unknown scan order\")\n\n\ndef estimate_scan_time(directories: List[Path], books_per_minute: float = 50.0) -> Tuple[float, str]:\n    \"\"\"Estimate how long scanning will take based on directory count.\"\"\"\n    \n    # Rough estimate: count subdirectories as potential books\n    estimated_books = 0\n    sample_size = min(10, len(directories))  # Sample first 10 directories\n    \n    for directory in directories[:sample_size]:\n        try:\n            subdirs = [d for d in directory.iterdir() if d.is_dir()]\n            estimated_books += len(subdirs)\n        except (OSError, PermissionError):\n            estimated_books += 5  # Default estimate\n    \n    # Scale up based on sample\n    if sample_size > 0:\n        total_estimated_books = (estimated_books / sample_size) * len(directories)\n    else:\n        total_estimated_books = len(directories) * 5  # Fallback estimate\n    \n    # Calculate time estimate\n    estimated_minutes = total_estimated_books / books_per_minute\n    \n    # Format time estimate\n    if estimated_minutes < 1:\n        time_str = \"less than 1 minute\"\n    elif estimated_minutes < 60:\n        time_str = f\"{estimated_minutes:.0f} minutes\"\n    else:\n        hours = estimated_minutes / 60\n        time_str = f\"{hours:.1f} hours\"\n    \n    return estimated_minutes, time_str\n