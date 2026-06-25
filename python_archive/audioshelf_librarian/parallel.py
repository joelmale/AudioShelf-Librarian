"""
Parallel processing utilities for AudioShelf Librarian.

This module provides thread-safe and async-capable versions of core operations
to take advantage of multiple CPU cores and improve performance when processing
large audiobook collections.

The key insight is that most audiobook processing is I/O bound (reading files,
scanning directories) rather than CPU bound, so we use ThreadPoolExecutor
for I/O operations and ProcessPoolExecutor only where it truly helps.
"""

import asyncio
import logging
import signal
import sys
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from functools import partial
from pathlib import Path
from typing import List, Dict, Optional, Callable, Any
import multiprocessing
import time
import threading

from .models import Book, Configuration, ScanResult
from .scanner import MetadataScanner
from .organizer import LibraryOrganizer, AudiobookOrganizer

logger = logging.getLogger(__name__)


class ProgressTracker:
    """
    Thread-safe progress tracker with signal handling for graceful cancellation.
    
    This provides real-time progress updates and allows users to cancel
    long-running operations with Ctrl+C while maintaining data integrity.
    """
    
    def __init__(self, total_items: int, description: str = "Processing"):
        self.total_items = total_items
        self.description = description
        self.completed_items = 0
        self.current_item = ""
        self.start_time = time.time()
        self.cancelled = False
        self.lock = threading.Lock()
        
        # Set up signal handler for graceful cancellation
        self._original_sigint_handler = signal.signal(signal.SIGINT, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle Ctrl+C gracefully."""
        print("\n🛑 Cancellation requested... finishing current operations...")
        self.cancelled = True
    
    def update(self, item_name: str = "", increment: int = 1):
        """Update progress with current item being processed."""
        with self.lock:
            self.completed_items += increment
            self.current_item = item_name
    
    def is_cancelled(self) -> bool:
        """Check if operation was cancelled."""
        return self.cancelled
    
    def get_progress_info(self) -> Dict[str, Any]:
        """Get current progress information."""
        with self.lock:
            elapsed = time.time() - self.start_time
            progress_pct = (self.completed_items / self.total_items) * 100 if self.total_items > 0 else 0
            
            # Estimate time remaining
            if self.completed_items > 0 and elapsed > 0:
                items_per_second = self.completed_items / elapsed
                remaining_items = self.total_items - self.completed_items
                eta_seconds = remaining_items / items_per_second if items_per_second > 0 else 0
            else:
                eta_seconds = 0
            
            return {
                'completed': self.completed_items,
                'total': self.total_items,
                'progress_pct': progress_pct,
                'current_item': self.current_item,
                'elapsed': elapsed,
                'eta_seconds': eta_seconds,
                'cancelled': self.cancelled
            }
    
    def cleanup(self):
        """Restore original signal handler."""
        signal.signal(signal.SIGINT, self._original_sigint_handler)


class CancellableOperation:
    """
    Wrapper for operations that can be cancelled gracefully.
    
    This ensures that when users press Ctrl+C, we finish processing
    the current items safely rather than corrupting data mid-operation.
    """
    
    def __init__(self, progress_tracker: ProgressTracker):
        self.progress_tracker = progress_tracker
    
    def should_continue(self) -> bool:
        """Check if operation should continue or was cancelled."""
        return not self.progress_tracker.is_cancelled()
    
    def process_with_cancellation(self, items: List, process_func: Callable, *args, **kwargs):
        """Process items with cancellation support."""
        results = []
        
        for i, item in enumerate(items):
            if not self.should_continue():
                print(f"\n⚠️  Operation cancelled. Processed {i}/{len(items)} items.")
                break
            
            try:
                result = process_func(item, *args, **kwargs)
                results.append(result)
                
                # Update progress with item name
                item_name = getattr(item, 'name', str(item))[:50]  # Truncate long names
                self.progress_tracker.update(item_name, 1)
                
            except Exception as e:
                logger.error(f"Error processing {item}: {e}")
                # Continue with other items even if one fails
                continue
        
        return results


class ParallelProcessor:
    """
    Manages parallel processing for audiobook operations.
    
    This class acts like a "CPU manager" - it knows when to use multiple
    threads, when to use multiple processes, and when to stick with
    single-threaded operation for optimal performance.
    """
    
    def __init__(self, config: Configuration, max_workers: Optional[int] = None):
        self.config = config
        # Default to CPU count, but cap at reasonable limit for I/O operations
        self.max_workers = max_workers or min(multiprocessing.cpu_count(), 8)
        self.scanner = MetadataScanner(config)
        self.organizer = AudiobookOrganizer(config)
        
        logger.info(f"Parallel processor initialized with {self.max_workers} workers")
    
    def scan_directories_parallel(self, paths: List[Path], progress_callback: Optional[Callable] = None, save_progress: bool = False, progress_tracker_external: Optional = None) -> List[Book]:
        """
        Scan multiple directories in parallel for audiobooks.
        
        This is where parallelization really shines - instead of scanning
        directories one by one, we can scan multiple directories simultaneously
        since each scan is mostly I/O (reading files from disk).
        
        Args:
            paths: List of directory paths to scan
            progress_callback: Optional callback function for progress updates
            
        Returns:
            List of all books found across all directories
        """
        if not paths:
            return []
        
        if len(paths) == 1:
            # Single directory - no need for parallelization overhead
            return self._scan_single_directory_for_books(paths[0])
        
        logger.info(f"Scanning {len(paths)} directories in parallel using {self.max_workers} workers")
        start_time = time.time()
        
        # Set up progress tracking
        if progress_tracker_external:
            # Use external progress tracker (from scan strategies)
            progress_tracker = progress_tracker_external
            cancellable_op = CancellableOperation(progress_tracker)
        else:
            # Create internal progress tracker
            progress_tracker = ProgressTracker(len(paths), "Scanning directories")
            cancellable_op = CancellableOperation(progress_tracker)
        
        all_books = []
        
        try:
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                # Submit all directory scan tasks
                future_to_path = {}
                
                for path in paths:
                    if not cancellable_op.should_continue():
                        break
                    
                    future = executor.submit(self._scan_single_directory_for_books, path)
                    future_to_path[future] = path
                
                # Collect results as they complete
                for future in as_completed(future_to_path):
                    if not cancellable_op.should_continue():
                        break
                    
                    path = future_to_path[future]
                    try:
                        books = future.result(timeout=30)  # Timeout to prevent hanging
                        all_books.extend(books)
                        
                        # Update progress with directory name and book count
                        progress_info = f"{path.name} ({len(books)} books)"
                        progress_tracker.update(progress_info, 1)
                        
                        # Call progress callback if provided
                        if progress_callback:
                            progress_data = progress_tracker.get_progress_info()
                            progress_callback(progress_data)
                        
                        logger.debug(f"Completed scanning {path}: found {len(books)} books")
                        
                    except Exception as e:
                        logger.error(f"Failed to scan directory {path}: {e}")
                        progress_tracker.update(f"{path.name} (error)", 1)
        
        except KeyboardInterrupt:
            logger.info("Scanning interrupted by user")
        finally:
            progress_tracker.cleanup()
        
        elapsed = time.time() - start_time
        final_progress = progress_tracker.get_progress_info()
        
        if final_progress['cancelled']:
            logger.info(f"Scanning cancelled after {elapsed:.2f}s: {len(all_books)} books found from {final_progress['completed']} directories")
        else:
            logger.info(f"Parallel scanning complete: {len(all_books)} books found in {elapsed:.2f}s")
        
        return all_books
    
    def extract_metadata_parallel(self, audio_directories: List[Path]) -> List[Book]:
        """
        Extract metadata from multiple audiobook directories in parallel.
        
        This parallelizes the metadata extraction process, which involves
        reading JSON files, parsing ID3 tags, and analyzing filenames.
        Each directory can be processed independently.
        
        Args:
            audio_directories: List of directories containing audiobooks
            
        Returns:
            List of Book objects with extracted metadata
        """
        if not audio_directories:
            return []
        
        if len(audio_directories) == 1:
            # Single directory - use regular scanner
            try:
                return [self.scanner.scan_directory(audio_directories[0])]
            except Exception as e:
                logger.error(f"Failed to scan {audio_directories[0]}: {e}")
                return []
        
        logger.info(f"Extracting metadata from {len(audio_directories)} directories in parallel")
        start_time = time.time()
        
        books = []
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit metadata extraction tasks
            future_to_dir = {
                executor.submit(self._safe_scan_directory, directory): directory
                for directory in audio_directories
            }
            
            # Collect results
            for future in as_completed(future_to_dir):
                directory = future_to_dir[future]
                try:
                    book = future.result()
                    if book:
                        books.append(book)
                        logger.debug(f"Extracted metadata for: {book.title}")
                except Exception as e:
                    logger.error(f"Failed to extract metadata from {directory}: {e}")
        
        elapsed = time.time() - start_time
        logger.info(f"Parallel metadata extraction complete: {len(books)} books processed in {elapsed:.2f}s")
        
        return books
    
    def organize_books_parallel(self, books: List[Book]) -> List:
        """
        Generate organization actions for multiple books in parallel.
        
        Path generation is CPU-bound and can benefit from parallel processing
        when dealing with large numbers of books. However, we need to be
        careful about conflict detection.
        
        Args:
            books: List of Book objects to organize
            
        Returns:
            List of OrganizationAction objects
        """
        if not books:
            return []
        
        if len(books) < 10:
            # Small number of books - overhead not worth it
            organizer = LibraryOrganizer(self.config)
            return organizer.organize_library(books)
        
        logger.info(f"Organizing {len(books)} books in parallel")
        start_time = time.time()
        
        actions = []
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit organization tasks
            future_to_book = {
                executor.submit(self._safe_organize_book, book): book
                for book in books
            }
            
            # Collect results
            for future in as_completed(future_to_book):
                book = future_to_book[future]
                try:
                    action = future.result()
                    if action:
                        actions.append(action)
                except Exception as e:
                    logger.error(f"Failed to organize book {book.title}: {e}")
        
        # Post-process to detect conflicts (must be done sequentially)
        actions = self._detect_and_resolve_conflicts(actions)
        
        elapsed = time.time() - start_time
        logger.info(f"Parallel organization complete: {len(actions)} actions generated in {elapsed:.2f}s")
        
        return actions
    
    async def scan_directories_async(self, paths: List[Path]) -> List[Book]:
        """
        Async version of directory scanning for integration with web frameworks.
        
        This is useful when the application is running as a web service and
        we don't want to block the event loop during long scanning operations.
        
        Args:
            paths: List of directory paths to scan
            
        Returns:
            List of all books found
        """
        if not paths:
            return []
        
        logger.info(f"Starting async scan of {len(paths)} directories")
        
        # Run the parallel scanning in a thread pool to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        books = await loop.run_in_executor(
            None,  # Use default executor
            self.scan_directories_parallel,
            paths
        )
        
        return books
    
    def _scan_single_directory_for_books(self, path: Path) -> List[Book]:
        """
        Scan a single directory for audiobooks, handling subdirectories.
        
        This is the thread-safe worker function that gets called in parallel.
        It scans one directory and all its subdirectories for audiobooks.
        """
        books = []
        
        if not path.exists() or not path.is_dir():
            logger.warning(f"Path does not exist or is not a directory: {path}")
            return books
        
        try:
            # Look for audiobook directories within this path
            for item in path.iterdir():
                if item.is_dir() and not item.name.startswith('.'):
                    # Check if this directory contains audio files
                    audio_files = []
                    for file_path in item.rglob('*'):
                        if (file_path.is_file() and 
                            file_path.suffix.lower() in self.scanner.AUDIO_EXTENSIONS):
                            audio_files.append(file_path)
                    
                    if audio_files:
                        try:
                            book = self.scanner.scan_directory(item)
                            books.append(book)
                            logger.debug(f"Found audiobook: {book.title} by {book.primary_author}")
                        except Exception as e:
                            logger.error(f"Failed to scan audiobook directory {item}: {e}")
            
        except Exception as e:
            logger.error(f"Error scanning directory {path}: {e}")
        
        return books
    
    def _safe_scan_directory(self, directory: Path) -> Optional[Book]:
        """
        Thread-safe wrapper for scanning a single audiobook directory.
        
        This catches exceptions to prevent one bad directory from killing
        the entire parallel operation.
        """
        try:
            return self.scanner.scan_directory(directory)
        except Exception as e:
            logger.error(f"Failed to scan directory {directory}: {e}")
            return None
    
    def _safe_organize_book(self, book: Book):
        """
        Thread-safe wrapper for organizing a single book.
        
        This generates organization actions for one book while catching
        any exceptions to prevent failure propagation.
        """
        try:
            return self.organizer.organize_book(book)
        except Exception as e:
            logger.error(f"Failed to organize book {book.title}: {e}")
            return None
    
    def _detect_and_resolve_conflicts(self, actions: List) -> List:
        """
        Detect and resolve conflicts in organization actions.
        
        This must be done sequentially after parallel processing because
        we need to check for multiple books targeting the same location.
        """
        from .models import ActionType
        
        conflicts = {}
        resolved_actions = []
        
        for action in actions:
            if not action:
                continue
                
            target_str = str(action.target_path)
            
            if target_str in conflicts:
                # Mark both actions as errors due to conflict
                original_action = conflicts[target_str]
                original_action.action_type = ActionType.ERROR
                original_action.reason = f"Conflict: Multiple books target same location"
                
                action.action_type = ActionType.ERROR
                action.reason = f"Conflict: Multiple books target same location"
            else:
                conflicts[target_str] = action
            
            resolved_actions.append(action)
        
        return resolved_actions


class PerformanceMonitor:
    """
    Monitors and reports on performance improvements from parallelization.
    
    This helps us understand whether parallel processing is actually helping
    and tune the number of workers for optimal performance.
    """
    
    def __init__(self):
        self.measurements = []
    
    def measure_operation(self, operation_name: str, operation_func: Callable, *args, **kwargs):
        """
        Measure the performance of an operation.
        
        This wraps any operation and records timing information for analysis.
        """
        start_time = time.time()
        start_cpu = time.process_time()
        
        try:
            result = operation_func(*args, **kwargs)
            success = True
            error = None
        except Exception as e:
            result = None
            success = False
            error = str(e)
        
        end_time = time.time()
        end_cpu = time.process_time()
        
        measurement = {
            'operation': operation_name,
            'wall_time': end_time - start_time,
            'cpu_time': end_cpu - start_cpu,
            'success': success,
            'error': error,
            'timestamp': start_time
        }
        
        self.measurements.append(measurement)
        
        if success:
            logger.info(f"{operation_name} completed in {measurement['wall_time']:.2f}s "
                       f"(CPU: {measurement['cpu_time']:.2f}s)")
        else:
            logger.error(f"{operation_name} failed after {measurement['wall_time']:.2f}s: {error}")
        
        return result
    
    def get_performance_report(self) -> Dict[str, Any]:
        """Generate a performance report from collected measurements."""
        if not self.measurements:
            return {"message": "No performance data collected"}
        
        successful_ops = [m for m in self.measurements if m['success']]
        
        if not successful_ops:
            return {"message": "No successful operations to analyze"}
        
        # Calculate statistics
        total_wall_time = sum(m['wall_time'] for m in successful_ops)
        total_cpu_time = sum(m['cpu_time'] for m in successful_ops)
        avg_wall_time = total_wall_time / len(successful_ops)
        
        # Group by operation type
        by_operation = {}
        for measurement in successful_ops:
            op_name = measurement['operation']
            if op_name not in by_operation:
                by_operation[op_name] = []
            by_operation[op_name].append(measurement)
        
        operation_stats = {}
        for op_name, measurements in by_operation.items():
            operation_stats[op_name] = {
                'count': len(measurements),
                'total_time': sum(m['wall_time'] for m in measurements),
                'avg_time': sum(m['wall_time'] for m in measurements) / len(measurements),
                'min_time': min(m['wall_time'] for m in measurements),
                'max_time': max(m['wall_time'] for m in measurements)
            }
        
        return {
            'total_operations': len(successful_ops),
            'total_wall_time': total_wall_time,
            'total_cpu_time': total_cpu_time,
            'average_wall_time': avg_wall_time,
            'cpu_efficiency': (total_cpu_time / total_wall_time) if total_wall_time > 0 else 0,
            'operations': operation_stats,
            'failed_operations': len(self.measurements) - len(successful_ops)
        }


def create_parallel_processor(config: Configuration, max_workers: Optional[int] = None) -> ParallelProcessor:
    """
    Factory function to create a parallel processor with optimal settings.
    
    This analyzes the system and configuration to determine the best
    number of workers for the current environment.
    """
    if max_workers is None:
        # Auto-detect optimal worker count
        cpu_count = multiprocessing.cpu_count()
        
        # For I/O bound operations, we can use more workers than CPU cores
        # But cap it to prevent resource exhaustion
        if cpu_count <= 2:
            # Low-end systems: be conservative
            max_workers = cpu_count
        elif cpu_count <= 4:
            # Medium systems: modest parallelization
            max_workers = cpu_count + 2
        else:
            # High-end systems: aggressive parallelization for I/O
            max_workers = min(cpu_count * 2, 16)
        
        logger.info(f"Auto-detected {cpu_count} CPUs, using {max_workers} workers for I/O operations")
    
    return ParallelProcessor(config, max_workers)


# Backwards compatibility functions that automatically use parallelization
def scan_directory_for_books_parallel(path: Path, config: Configuration) -> List[Book]:
    """
    Enhanced version of scan_directory_for_books that uses parallel processing.
    
    This is a drop-in replacement for the original function that automatically
    takes advantage of multiple CPU cores when beneficial.
    """
    processor = create_parallel_processor(config)
    
    # If it's a single directory, scan it directly
    if path.is_file() or not any(path.iterdir()):
        # Use original single-threaded function for simple cases
        from .scanner import scan_directory_for_books
        return scan_directory_for_books(path, config)
    
    # For directories with subdirectories, use parallel processing
    subdirs = [item for item in path.iterdir() if item.is_dir() and not item.name.startswith('.')]
    
    if len(subdirs) <= 1:
        # Not enough subdirectories to benefit from parallelization
        from .scanner import scan_directory_for_books
        return scan_directory_for_books(path, config)
    
    # Use parallel processing for multiple subdirectories
    return processor.scan_directories_parallel(subdirs)
