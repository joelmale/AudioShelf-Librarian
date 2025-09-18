"""
Main application entry point.

This module provides both CLI and web interfaces for the AudioShelf Librarian.
It's like the "front desk" of the application - it handles user interactions
and coordinates between the various components.
"""

import logging
import sys
import shutil
import signal
import time
from pathlib import Path
from typing import List, Optional
import typer
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
from rich.panel import Panel
from rich.text import Text

# Import our core modules
from .models import Configuration, MetadataSource, OrganizationAction, ActionType
from .scanner import MetadataScanner, scan_directory_for_books
from .organizer import LibraryOrganizer
from .parallel import create_parallel_processor, PerformanceMonitor, scan_directory_for_books_parallel

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create CLI app
cli_app = typer.Typer(
    help="AudioShelf Librarian - Organize your audiobook library\n\n"
         "💡 Tip: Press Ctrl+C to cancel any long-running operation safely."
)
console = Console()


def setup_signal_handlers():
    """Set up signal handlers for graceful shutdown."""
    def signal_handler(signum, frame):
        console.print("\n[yellow]Received interrupt signal. Gracefully shutting down...[/yellow]")
        # Let the specific operations handle their own cleanup
        # This just ensures we exit cleanly from the main CLI
        pass
    
    signal.signal(signal.SIGINT, signal_handler)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, signal_handler)


def create_default_config() -> Configuration:
    """Create a default configuration for the application."""
    return Configuration(
        library_path=Path("/audiobooks"),
        inbox_path=Path("/audiobooks/inbox"),
        prefer_series_structure=True,
        include_year_in_titles=False,
        include_narrator_in_names=False,
        metadata_source_priority=[
            MetadataSource.ABS_JSON,
            MetadataSource.ID3_TAGS,
            MetadataSource.FILENAME
        ],
        require_confirmation=True,
        create_backups=True,
        scan_subdirectories=True,
        skip_hidden_files=True,
        minimum_confidence_threshold=0.5
    )


@cli_app.command("scan")
def scan_command(
    path: str = typer.Argument(..., help="Path to scan for audiobooks"),
    library_path: str = typer.Option("/audiobooks", "--library-path", "-l", help="AudioBookShelf library root path where books should be organized"),
    dry_run: bool = typer.Option(True, "--dry-run/--execute", help="Preview actions without executing (default: True). Use --execute to actually move files"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable detailed output including performance metrics and debug information"),
    parallel: bool = typer.Option(True, "--parallel/--no-parallel", help="Use parallel processing for faster scanning (default: True). Disable for slow storage or debugging"),
    max_workers: Optional[int] = typer.Option(None, "--max-workers", "-w", help="Maximum number of worker threads (auto-detected based on CPU cores if not specified)"),
    scan_order: str = typer.Option("alphabetical", "--scan-order", "-o", help="Scanning order: 'alphabetical' (A-Z), 'reverse' (Z-A), 'random', 'quarters' (split into 4 parts), 'eighths' (split into 8 parts)"),
    resume_from: Optional[str] = typer.Option(None, "--resume-from", "-r", help="Resume scanning from a specific directory name (useful for large libraries)"),
    save_progress: bool = typer.Option(False, "--save-progress", "-s", help="Save progress to allow resuming later if interrupted")
):
    """
    Scan a directory for audiobooks and show organization plan.
    
    This is like the "inspection mode" - it examines your books and tells you
    what needs to be organized without actually moving anything.
    """
    setup_signal_handlers()
    
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    console.print(f"[bold blue]Scanning audiobooks in:[/bold blue] {path}")
    
    # Create configuration
    config = create_default_config()
    config.library_path = Path(library_path)
    
    try:
        # Set up scan strategy
        from .scan_strategies import ScanStrategy, ScanOrder, estimate_scan_time, get_scan_order_description
        
        strategy = ScanStrategy()
        scan_order_enum = ScanOrder(scan_order)
        
        console.print(f"[blue]Scan Strategy:[/blue] {get_scan_order_description(scan_order_enum)}")
        
        # Check for existing progress
        existing_progress = None
        if save_progress:
            existing_progress = strategy.load_progress()
            if existing_progress and not resume_from:
                if typer.confirm(f"Found previous scan progress ({existing_progress.completed_directories}/{existing_progress.total_directories} completed). Resume?"):
                    resume_from = existing_progress.current_directory
        
        # Scan for books
        monitor = PerformanceMonitor()
        
        # Create a progress callback for detailed status
        def progress_callback(progress_data):
            if progress_data['total'] > 0:
                pct = progress_data['progress_pct']
                current = progress_data['current_item']
                completed = progress_data['completed']
                total = progress_data['total']
                
                # Calculate ETA
                eta = progress_data['eta_seconds']
                eta_str = f"{int(eta//60)}m {int(eta%60)}s" if eta > 0 else "calculating..."
                
                # Update progress description with current status
                progress.update(
                    scan_task, 
                    completed=completed,
                    total=total,
                    description=f"[{completed}/{total}] {current[:40]}... (ETA: {eta_str})"
                )
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            console=console
        ) as progress:
            scan_task = progress.add_task("Scanning directories...", total=100)
            
            if parallel:
                # For parallel scanning, we need to find and order subdirectories first
                scan_path = Path(path)
                if scan_path.is_dir():
                    subdirs = [item for item in scan_path.iterdir() 
                              if item.is_dir() and not item.name.startswith('.')]
                    
                    if subdirs:
                        # Apply scan strategy
                        ordered_subdirs = strategy.order_directories(subdirs, scan_order_enum, resume_from)
                        
                        # Show time estimate
                        est_minutes, est_time_str = estimate_scan_time(ordered_subdirs)
                        console.print(f"[dim]Estimated scan time: {est_time_str} for {len(ordered_subdirs)} directories[/dim]")
                        
                        # Create scan progress tracker
                        scan_id = strategy.create_scan_id(scan_path, scan_order_enum)
                        from .scan_strategies import ScanProgress
                        
                        scan_progress = ScanProgress(
                            scan_id=scan_id,
                            total_directories=len(ordered_subdirs),
                            completed_directories=0,
                            current_directory=None,
                            scan_order=scan_order_enum,
                            start_time=time.time(),
                            last_update_time=time.time(),
                            remaining_directories=[str(d) for d in ordered_subdirs]
                        )
                        
                        if len(ordered_subdirs) > 1:
                            # Multiple subdirectories - use parallel with progress tracking
                            processor = create_parallel_processor(config, max_workers)
                            
                            # Enhanced progress callback with strategy info
                            def enhanced_progress_callback(progress_data):
                                if progress_data['total'] > 0:
                                    pct = progress_data['progress_pct']
                                    current = progress_data['current_item']
                                    completed = progress_data['completed']
                                    total = progress_data['total']
                                    
                                    # Update scan progress
                                    scan_progress.completed_directories = completed
                                    scan_progress.current_directory = current
                                    scan_progress.last_update_time = time.time()
                                    
                                    # Save progress if requested
                                    if save_progress and completed % 5 == 0:  # Save every 5 directories
                                        strategy.save_progress(scan_progress)
                                    
                                    # Calculate ETA
                                    eta = progress_data['eta_seconds']
                                    eta_str = f"{int(eta//60)}m {int(eta%60)}s" if eta > 0 else "calculating..."
                                    
                                    # Show strategy in progress description
                                    progress.update(
                                        scan_task, 
                                        completed=completed,
                                        total=total,
                                        description=f"[{scan_order}] [{completed}/{total}] {current[:30]}... (ETA: {eta_str})"
                                    )
                            
                            books = processor.scan_directories_parallel(ordered_subdirs, enhanced_progress_callback)
                            
                            # Final progress save
                            if save_progress:
                                scan_progress.completed_directories = len(ordered_subdirs)
                                scan_progress.books_found = len(books)
                                strategy.save_progress(scan_progress)
                        else:
                            # Single directory - use regular function
                            books = monitor.measure_operation(
                                "single_dir_scan",
                                scan_directory_for_books,
                                ordered_subdirs[0] if ordered_subdirs else scan_path, config
                            )
                    else:
                        # No subdirectories found
                        books = monitor.measure_operation(
                            "empty_dir_scan",
                            scan_directory_for_books,
                            scan_path, config
                        )
                else:
                    books = []
            else:
                books = monitor.measure_operation(
                    "sequential_scan", 
                    scan_directory_for_books,
                    Path(path), config
                )
            
            progress.update(scan_task, completed=100)
        
        # Show performance info if verbose
        if verbose:
            perf_report = monitor.get_performance_report()
            console.print(f"[dim]Performance: {perf_report.get('total_wall_time', 0):.2f}s total, "
                         f"CPU efficiency: {perf_report.get('cpu_efficiency', 0):.1%}[/dim]")
        
        # Show scan strategy summary
        if len(books) > 0:
            console.print(f"\n[green]Scan completed using {scan_order} strategy[/green]")
            if resume_from:
                console.print(f"[dim]Resumed from: {resume_from}[/dim]")
            if save_progress:
                console.print(f"[dim]Progress saved for future resume[/dim]")
        
        if not books:
            console.print("[yellow]No audiobooks found in the specified directory.[/yellow]")
            return
        
        console.print(f"[green]Found {len(books)} audiobooks[/green]")
        
        # Generate organization plan
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console
        ) as progress:
            org_task = progress.add_task("Generating organization plan...", total=None)
            
            if parallel and len(books) > 10:
                processor = create_parallel_processor(config, max_workers)
                actions = monitor.measure_operation(
                    "parallel_organization",
                    processor.organize_books_parallel,
                    books
                )
                
                # Calculate statistics manually for preview format
                stats = {
                    'total_books': len(books),
                    'books_to_move': len([a for a in actions if a.action_type == ActionType.MOVE]),
                    'books_to_rename': len([a for a in actions if a.action_type == ActionType.RENAME]),
                    'books_already_organized': len([a for a in actions if a.action_type == ActionType.SKIP]),
                    'books_with_errors': len([a for a in actions if a.action_type == ActionType.ERROR]),
                    'actions_by_type': {},
                    'estimated_operations': len([a for a in actions if a.will_change_location])
                }
                
                for action in actions:
                    action_type = action.action_type
                    stats['actions_by_type'][action_type.value] = stats['actions_by_type'].get(action_type.value, 0) + 1
                
                preview = {
                    'actions': actions,
                    'statistics': stats,
                    'safe_to_execute': stats['books_with_errors'] == 0
                }
            else:
                organizer = LibraryOrganizer(config)
                preview = monitor.measure_operation(
                    "sequential_organization",
                    organizer.preview_organization,
                    books
                )
            
            progress.update(org_task, completed=True)
        
        # Display results
        display_scan_results(books, preview)
        
        if not dry_run:
            if typer.confirm("Do you want to execute the organization plan?"):
                execute_organization_plan(preview['actions'], config)
            else:
                console.print("[yellow]Organization cancelled by user.[/yellow]")
        
    except Exception as e:
        console.print(f"[red]Error during scan: {str(e)}[/red]")
        if verbose:
            logger.exception("Detailed error information:")
        sys.exit(1)


@cli_app.command("organize")
def organize_command(
    inbox_path: str = typer.Option("/audiobooks/inbox", "--inbox-path", "-i", help="Directory containing new audiobooks to be organized into the library"),
    library_path: str = typer.Option("/audiobooks", "--library-path", "-l", help="Target AudioBookShelf library directory where books will be moved"),
    dry_run: bool = typer.Option(True, "--dry-run/--execute", help="Preview actions without executing (default: True). Use --execute to actually move files"),
    auto_confirm: bool = typer.Option(False, "--auto-confirm", "-y", help="Automatically confirm all actions without prompting (use with caution!)"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show detailed processing information and performance metrics"),
    parallel: bool = typer.Option(True, "--parallel/--no-parallel", help="Use parallel processing for faster organization (default: True)"),
    max_workers: Optional[int] = typer.Option(None, "--max-workers", "-w", help="Maximum number of worker threads for parallel processing"),
    scan_order: str = typer.Option("alphabetical", "--scan-order", "-o", help="Order to process inbox items: 'alphabetical', 'reverse', 'random', 'quarters', 'eighths'"),
    resume_from: Optional[str] = typer.Option(None, "--resume-from", "-r", help="Resume processing from a specific directory (useful if previous operation was interrupted)")
):
    """
    Process audiobooks from the inbox directory.
    
    This is the "inbox processor" - it takes new audiobooks from your inbox
    and organizes them into your main library according to AudioBookShelf conventions.
    """
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    console.print(f"[bold blue]Processing inbox:[/bold blue] {inbox_path}")
    
    # Create configuration
    config = create_default_config()
    config.library_path = Path(library_path)
    config.inbox_path = Path(inbox_path)
    config.require_confirmation = not auto_confirm
    
    try:
        # Check if inbox exists
        inbox = Path(inbox_path)
        if not inbox.exists():
            console.print(f"[red]Inbox directory does not exist: {inbox_path}[/red]")
            sys.exit(1)
        
        # Scan inbox for books
        monitor = PerformanceMonitor()
        
        # Set up scan strategy for inbox processing
        from .scan_strategies import ScanStrategy, ScanOrder, get_scan_order_description
        strategy = ScanStrategy()
        scan_order_enum = ScanOrder(scan_order)
        
        if scan_order != "alphabetical":
            console.print(f"[blue]Processing inbox using {scan_order} order[/blue]")
        
        if parallel:
            # Apply scan ordering to inbox items
            inbox_items = [item for item in inbox.iterdir() 
                          if item.is_dir() and not item.name.startswith('.')]
            
            if inbox_items:
                ordered_items = strategy.order_directories(inbox_items, scan_order_enum, resume_from)
                books = monitor.measure_operation(
                    "parallel_inbox_scan",
                    scan_directory_for_books_parallel,
                    Path(str(ordered_items[0].parent)), config  # Scan the inbox with ordered processing
                )
            else:
                books = []
        else:
            books = monitor.measure_operation(
                "sequential_inbox_scan",
                scan_directory_for_books,
                inbox, config
            )
        
        if not books:
            console.print("[yellow]No audiobooks found in inbox.[/yellow]")
            return
        
        console.print(f"[green]Found {len(books)} audiobooks in inbox[/green]")
        
        # Generate organization plan
        if parallel and len(books) > 10:
            processor = create_parallel_processor(config, max_workers)
            actions = monitor.measure_operation(
                "parallel_inbox_organization",
                processor.organize_books_parallel,
                books
            )
            
            # Calculate statistics manually for preview format
            stats = {
                'total_books': len(books),
                'books_to_move': len([a for a in actions if a.action_type == ActionType.MOVE]),
                'books_to_rename': len([a for a in actions if a.action_type == ActionType.RENAME]),
                'books_already_organized': len([a for a in actions if a.action_type == ActionType.SKIP]),
                'books_with_errors': len([a for a in actions if a.action_type == ActionType.ERROR]),
                'actions_by_type': {},
                'estimated_operations': len([a for a in actions if a.will_change_location])
            }
            
            for action in actions:
                action_type = action.action_type
                stats['actions_by_type'][action_type.value] = stats['actions_by_type'].get(action_type.value, 0) + 1
            
            preview = {
                'actions': actions,
                'statistics': stats,
                'safe_to_execute': stats['books_with_errors'] == 0
            }
        else:
            organizer = LibraryOrganizer(config)
            preview = monitor.measure_operation(
                "sequential_inbox_organization",
                organizer.preview_organization,
                books
            )
        
        # Show performance info if verbose
        if verbose:
            perf_report = monitor.get_performance_report()
            console.print(f"[dim]Performance: {perf_report.get('total_wall_time', 0):.2f}s total[/dim]")
        
        # Display results
        display_scan_results(books, preview)
        
        if not dry_run:
            should_execute = auto_confirm or typer.confirm("Do you want to execute the organization plan?")
            if should_execute:
                execute_organization_plan(preview['actions'], config)
            else:
                console.print("[yellow]Organization cancelled by user.[/yellow]")
        
    except Exception as e:
        console.print(f"[red]Error during organization: {str(e)}[/red]")
        if verbose:
            logger.exception("Detailed error information:")
        sys.exit(1)


@cli_app.command("validate")
def validate_command(
    library_path: str = typer.Option("/audiobooks", "--library-path", "-l", help="Path to AudioBookShelf library to validate for compliance with naming conventions"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show detailed validation results and performance information"),
    parallel: bool = typer.Option(True, "--parallel/--no-parallel", help="Use parallel processing for faster validation (default: True)"),
    show_compliant: bool = typer.Option(False, "--show-compliant", help="Also show books that are already properly organized (normally only shows issues)"),
    max_issues: int = typer.Option(20, "--max-issues", help="Maximum number of non-compliant books to display in detail (default: 20)")
):
    """
    Validate that the library follows AudioBookShelf conventions.
    
    This is the "quality inspector" - it examines your existing library
    and tells you what's properly organized and what needs attention.
    """
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    console.print(f"[bold blue]Validating library:[/bold blue] {library_path}")
    
    # Create configuration
    config = create_default_config()
    config.library_path = Path(library_path)
    
    try:
        # Scan library
        monitor = PerformanceMonitor()
        
        if parallel:
            books = monitor.measure_operation(
                "parallel_library_scan",
                scan_directory_for_books_parallel,
                Path(library_path), config
            )
        else:
            books = monitor.measure_operation(
                "sequential_library_scan",
                scan_directory_for_books,
                Path(library_path), config
            )
        
        # Show performance info if verbose
        if verbose:
            perf_report = monitor.get_performance_report()
            console.print(f"[dim]Scanning performance: {perf_report.get('total_wall_time', 0):.2f}s total, "
                         f"CPU efficiency: {perf_report.get('cpu_efficiency', 0):.1%}[/dim]")
        
        if not books:
            console.print("[yellow]No audiobooks found in library.[/yellow]")
            return
        
        # Validate compliance
        organizer = LibraryOrganizer(config)
        compliance_report = organizer.validate_library_compliance(books)
        
        # Display compliance report
        display_compliance_report(compliance_report)
        
    except Exception as e:
        console.print(f"[red]Error during validation: {str(e)}[/red]")
        if verbose:
            logger.exception("Detailed error information:")
        sys.exit(1)


def display_scan_results(books: List, preview: dict):
    """Display the results of scanning and organization planning."""
    
    # Summary statistics
    stats = preview['statistics']
    
    # Create summary panel
    summary_text = Text()
    summary_text.append(f"Total books found: {stats['total_books']}\n", style="white")
    summary_text.append(f"Books to move: {stats['books_to_move']}\n", style="cyan")
    summary_text.append(f"Books to rename: {stats['books_to_rename']}\n", style="yellow")
    summary_text.append(f"Already organized: {stats['books_already_organized']}\n", style="green")
    if stats['books_with_errors'] > 0:
        summary_text.append(f"Errors: {stats['books_with_errors']}", style="red")
    
    console.print(Panel(summary_text, title="[bold]Scan Summary[/bold]", border_style="blue"))
    
    # Detailed actions table
    if stats['estimated_operations'] > 0:
        console.print("\n[bold]Proposed Actions:[/bold]")
        
        table = Table(show_header=True, header_style="bold magenta")
        table.add_column("Action", style="cyan", width=8)
        table.add_column("Book Title", style="green", width=35)
        table.add_column("Author", style="blue", width=25)
        table.add_column("Current Location", style="yellow", width=30)
        table.add_column("Target Location", style="white", width=40)
        table.add_column("Reason", style="dim", width=40)
        
        for action in preview['actions']:
            if action.will_change_location:
                table.add_row(
                    action.action_type.value.upper(),
                    action.book.title[:32] + "..." if len(action.book.title) > 32 else action.book.title,
                    action.book.primary_author[:22] + "..." if len(action.book.primary_author) > 22 else action.book.primary_author,
                    str(action.source_path.name)[:27] + "..." if len(str(action.source_path.name)) > 27 else str(action.source_path.name),
                    str(action.target_path)[:37] + "..." if len(str(action.target_path)) > 37 else str(action.target_path),
                    action.reason[:37] + "..." if len(action.reason) > 37 else action.reason
                )
        
        console.print(table)
    
    # Show errors if any
    error_actions = [action for action in preview['actions'] if action.action_type == ActionType.ERROR]
    if error_actions:
        console.print("\n[bold red]Errors Found:[/bold red]")
        error_table = Table(show_header=True, header_style="bold red")
        error_table.add_column("Book Title", style="white")
        error_table.add_column("Author", style="blue")
        error_table.add_column("Error", style="red")
        
        for action in error_actions:
            error_table.add_row(
                action.book.title[:40] + "..." if len(action.book.title) > 40 else action.book.title,
                action.book.primary_author[:25] + "..." if len(action.book.primary_author) > 25 else action.book.primary_author,
                action.reason
            )
        
        console.print(error_table)


def display_compliance_report(report: dict):
    """Display a library compliance report."""
    
    # Overall compliance metrics
    total = report['total_books']
    compliant = report['compliant_books']
    non_compliant = report['non_compliant_books']
    rate = report['compliance_rate']
    
    # Create compliance summary panel
    summary_text = Text()
    summary_text.append(f"Total books: {total}\n", style="white")
    summary_text.append(f"Compliant: {compliant}\n", style="green")
    summary_text.append(f"Non-compliant: {non_compliant}\n", style="red" if non_compliant > 0 else "white")
    summary_text.append(f"Compliance rate: {rate:.1%}", style="green" if rate > 0.8 else "yellow" if rate > 0.5 else "red")
    
    console.print(Panel(summary_text, title="[bold]Library Compliance Report[/bold]", border_style="blue"))
    
    # Show common issues if any
    if report['common_issues']:
        console.print("\n[bold red]Common Issues Found:[/bold red]")
        for i, issue in enumerate(report['common_issues'][:10], 1):  # Limit to top 10
            console.print(f"  {i}. {issue}")
    
    # Show recommendations
    if report['recommendations']:
        console.print("\n[bold yellow]Recommendations:[/bold yellow]")
        for i, rec in enumerate(report['recommendations'][:5], 1):  # Limit to top 5
            console.print(f"  {i}. {rec}")
    
    # Detailed results table for non-compliant books
    non_compliant_details = [
        result for result in report['detailed_results'] 
        if not result['compliance']['is_compliant']
    ]
    
    if non_compliant_details and len(non_compliant_details) <= 20:  # Only show details if manageable
        console.print("\n[bold]Non-Compliant Books:[/bold]")
        
        table = Table(show_header=True, header_style="bold magenta")
        table.add_column("Book Title", style="green", width=35)
        table.add_column("Author", style="blue", width=25)
        table.add_column("Current Path", style="yellow", width=40)
        table.add_column("Issues", style="red", width=50)
        
        for result in non_compliant_details[:20]:  # Limit to first 20
            book = result['book']
            compliance = result['compliance']
            issues_text = "; ".join(compliance['issues'][:2])  # Show first 2 issues
            if len(compliance['issues']) > 2:
                issues_text += f" (and {len(compliance['issues']) - 2} more)"
            
            table.add_row(
                book.title[:32] + "..." if len(book.title) > 32 else book.title,
                book.primary_author[:22] + "..." if len(book.primary_author) > 22 else book.primary_author,
                str(book.source_path)[:37] + "..." if len(str(book.source_path)) > 37 else str(book.source_path),
                issues_text[:47] + "..." if len(issues_text) > 47 else issues_text
            )
        
        console.print(table)
        
        if len(non_compliant_details) > 20:
            console.print(f"\n[dim]... and {len(non_compliant_details) - 20} more non-compliant books[/dim]")


def execute_organization_plan(actions: List[OrganizationAction], config: Configuration):
    """
    Execute the organization plan by performing actual file operations.
    
    This is the "action executor" - it takes the plan and actually moves/renames
    files according to the proposed actions. It includes safety checks and
    progress reporting.
    """
    console.print("\n[bold green]Executing Organization Plan[/bold green]")
    
    # Filter out actions that don't require file operations
    executable_actions = [
        action for action in actions 
        if action.action_type in (ActionType.MOVE, ActionType.RENAME) and action.will_change_location
    ]
    
    if not executable_actions:
        console.print("[yellow]No file operations needed - all books are already organized![/yellow]")
        return
    
    console.print(f"Executing {len(executable_actions)} file operations...")
    
    success_count = 0
    error_count = 0
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        console=console
    ) as progress:
        
        task = progress.add_task("Organizing books...", total=len(executable_actions))
        
        for action in executable_actions:
            try:
                progress.update(task, description=f"Processing: {action.book.title[:30]}...")
                
                # Create target directory if it doesn't exist
                action.target_path.parent.mkdir(parents=True, exist_ok=True)
                
                # Perform the file operation
                if action.action_type == ActionType.MOVE:
                    # Move entire directory
                    shutil.move(str(action.source_path), str(action.target_path))
                    action.success = True
                    success_count += 1
                    logger.info(f"Moved: {action.source_path} → {action.target_path}")
                    
                elif action.action_type == ActionType.RENAME:
                    # Rename in place
                    action.source_path.rename(action.target_path)
                    action.success = True
                    success_count += 1
                    logger.info(f"Renamed: {action.source_path} → {action.target_path}")
                
                action.executed = True
                
            except Exception as e:
                action.success = False
                action.error_message = str(e)
                action.executed = True
                error_count += 1
                logger.error(f"Failed to organize {action.book.title}: {e}")
                console.print(f"[red]Error organizing {action.book.title}: {str(e)}[/red]")
            
            progress.advance(task)
    
    # Display final results
    console.print(f"\n[bold]Organization Complete![/bold]")
    console.print(f"[green]Successfully organized: {success_count} books[/green]")
    
    if error_count > 0:
        console.print(f"[red]Failed to organize: {error_count} books[/red]")
        console.print("[yellow]Check the logs above for specific error details.[/yellow]")
    
    # Show summary of what was accomplished
    if success_count > 0:
        console.print(f"\n[dim]Your audiobook library has been organized according to AudioBookShelf conventions.[/dim]")
        console.print(f"[dim]Organized books are now properly structured for optimal AudioBookShelf scanning.[/dim]")


@cli_app.command("benchmark")
def benchmark_command(
    path: str = typer.Argument(..., help="Path to audiobook directory to use for performance testing (should contain multiple subdirectories)"),
    iterations: int = typer.Option(3, "--iterations", "-n", help="Number of times to run each test for reliable timing (default: 3). More iterations = more accurate results but longer test time"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show detailed timing for each individual test run and system information"),
    include_organization: bool = typer.Option(False, "--include-organization", help="Also benchmark the organization planning phase (takes longer but more comprehensive)"),
    max_workers_test: Optional[int] = typer.Option(None, "--max-workers-test", help="Test with specific number of workers instead of auto-detection")
):
    """
    Benchmark parallel vs sequential processing performance.
    
    This command runs both parallel and sequential processing on the same
    directory to show the performance difference and help optimize settings.
    """
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    console.print(f"[bold blue]Benchmarking performance on:[/bold blue] {path}")
    console.print(f"Running {iterations} iterations of each method...\n")
    
    config = create_default_config()
    scan_path = Path(path)
    
    if not scan_path.exists():
        console.print(f"[red]Path does not exist: {path}[/red]")
        sys.exit(1)
    
    sequential_times = []
    parallel_times = []
    
    try:
        # Run sequential benchmarks
        console.print("[yellow]Running sequential processing benchmarks...[/yellow]")
        for i in range(iterations):
            monitor = PerformanceMonitor()
            
            with Progress(
                SpinnerColumn(),
                TextColumn(f"Sequential run {i+1}/{iterations}"),
                console=console
            ) as progress:
                task = progress.add_task("Processing...", total=None)
                
                books = monitor.measure_operation(
                    "sequential_benchmark",
                    scan_directory_for_books,
                    scan_path, config
                )
                
                progress.update(task, completed=True)
            
            perf_report = monitor.get_performance_report()
            sequential_times.append(perf_report['total_wall_time'])
            
            if verbose:
                console.print(f"  Run {i+1}: {perf_report['total_wall_time']:.2f}s")
        
        # Run parallel benchmarks
        console.print("\n[cyan]Running parallel processing benchmarks...[/cyan]")
        for i in range(iterations):
            monitor = PerformanceMonitor()
            
            with Progress(
                SpinnerColumn(),
                TextColumn(f"Parallel run {i+1}/{iterations}"),
                console=console
            ) as progress:
                task = progress.add_task("Processing...", total=None)
                
                books = monitor.measure_operation(
                    "parallel_benchmark",
                    scan_directory_for_books_parallel,
                    scan_path, config
                )
                
                progress.update(task, completed=True)
            
            perf_report = monitor.get_performance_report()
            parallel_times.append(perf_report['total_wall_time'])
            
            if verbose:
                console.print(f"  Run {i+1}: {perf_report['total_wall_time']:.2f}s")
        
        # Calculate and display results
        seq_avg = sum(sequential_times) / len(sequential_times)
        par_avg = sum(parallel_times) / len(parallel_times)
        speedup = seq_avg / par_avg if par_avg > 0 else 0
        
        console.print("\n[bold]Benchmark Results:[/bold]")
        
        results_table = Table(show_header=True, header_style="bold magenta")
        results_table.add_column("Method", style="cyan")
        results_table.add_column("Average Time", style="green")
        results_table.add_column("Best Time", style="blue")
        results_table.add_column("Worst Time", style="red")
        
        results_table.add_row(
            "Sequential",
            f"{seq_avg:.2f}s",
            f"{min(sequential_times):.2f}s",
            f"{max(sequential_times):.2f}s"
        )
        
        results_table.add_row(
            "Parallel",
            f"{par_avg:.2f}s",
            f"{min(parallel_times):.2f}s",
            f"{max(parallel_times):.2f}s"
        )
        
        console.print(results_table)
        
        # Performance analysis
        if speedup > 1.2:
            console.print(f"\n[bold green]✓ Parallel processing is {speedup:.1f}x faster![/bold green]")
            console.print("[green]Recommendation: Use parallel processing (--parallel)[/green]")
        elif speedup > 0.8:
            console.print(f"\n[yellow]≈ Performance is similar ({speedup:.1f}x)[/yellow]")
            console.print("[yellow]Recommendation: Either method works fine[/yellow]")
        else:
            console.print(f"\n[red]⚠ Sequential is faster ({1/speedup:.1f}x)[/red]")
            console.print("[red]Recommendation: Use sequential processing (--no-parallel)[/red]")
        
        console.print(f"\n[dim]Tested with {len(books) if 'books' in locals() else 'unknown'} audiobooks[/dim]")
        
    except Exception as e:
        console.print(f"[red]Benchmark failed: {str(e)}[/red]")
        if verbose:
            logger.exception("Detailed benchmark error:")
        sys.exit(1)


@cli_app.command("version")
def version_command():
    """Display version information."""
    console.print("[bold blue]AudioShelf Librarian[/bold blue]")
    console.print("Version: 1.0.0")
    console.print("A tool for organizing audiobook libraries according to AudioBookShelf conventions")


if __name__ == "__main__":
    cli_app()
