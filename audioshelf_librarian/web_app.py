"""
FastAPI web application for AudioShelf Librarian.

This module provides a modern web interface for organizing audiobook libraries
with real-time progress updates, interactive controls, and a responsive UI.
The web app exposes all CLI functionality through HTTP endpoints and WebSockets.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Form, Query
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import uvicorn

# Import our core modules
from .models import Configuration, MetadataSource, Book, OrganizationAction, ActionType
from .scanner import scan_directory_for_books
from .organizer import LibraryOrganizer
from .parallel import create_parallel_processor, PerformanceMonitor
from .scan_strategies import ScanStrategy, ScanOrder, ScanProgress
from .abs_maintenance import (
    ABSMaintenanceClient,
    ABSMaintenanceError,
    ANCHOR_GENRES,
    DISCARD_GENRES,
    GENRE_MAPPING,
    GenreCleanupResult,
)
from .settings import SettingsError, SettingsStore
from .config import create_default_config

logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="AudioShelf Librarian",
    description="Web interface for organizing audiobook libraries according to AudioBookShelf conventions",
    version="1.0.0"
)

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Global state management
active_operations: Dict[str, Dict[str, Any]] = {}
websocket_connections: Dict[str, WebSocket] = {}
settings_store = SettingsStore()


class ScanRequest(BaseModel):
    """Request model for scan operations."""
    path: str
    library_path: str = "/audiobooks"
    scan_order: str = "alphabetical"
    parallel: bool = True
    max_workers: Optional[int] = None
    resume_from: Optional[str] = None
    save_progress: bool = False


class OrganizeRequest(BaseModel):
    """Request model for organize operations."""
    inbox_path: str = "/audiobooks/inbox"
    library_path: str = "/audiobooks"
    scan_order: str = "alphabetical"
    parallel: bool = True
    max_workers: Optional[int] = None
    auto_confirm: bool = False


class GenreCleanupRequest(BaseModel):
    """Request model for ABS genre cleanup maintenance."""

    abs_url: Optional[str] = None
    api_token: Optional[str] = None
    library_id: Optional[str] = None
    keep_unmapped: bool = True
    preserve_dropped_as_tags: bool = False
    write: bool = False


class SettingsRequest(BaseModel):
    """Request model for saved ABS connection settings."""

    abs_url: str = ""
    api_token: Optional[str] = None
    library_id: str = ""
    library_name: str = ""
    library_folder: str = ""
    library_media_type: str = ""
    debug_mode: bool = False


class ConnectionTestRequest(BaseModel):
    """Request model for validating saved or supplied ABS connection settings."""

    abs_url: Optional[str] = None
    api_token: Optional[str] = None
    debug_mode: Optional[bool] = None


class ExecuteRequest(BaseModel):
    """Request model for executing organization actions."""
    operation_id: str
    confirmed_actions: List[int]  # Indices of actions to execute


class ProgressUpdate(BaseModel):
    """Model for progress update messages."""
    operation_id: str
    operation_type: str
    progress_pct: float
    current_item: str
    completed: int
    total: int
    elapsed_time: float
    eta_seconds: float
    scan_strategy: Optional[str] = None
    books_found: int = 0
    status: str = "running"  # running, completed, cancelled, error, paused
    # New fields for parallel processing info
    parallel_enabled: bool = False
    active_workers: int = 0
    max_workers: int = 1
    worker_stats: Optional[Dict[str, Any]] = None
    # Progress saving info
    last_completed_directory: Optional[str] = None
    paused: bool = False
    # New parallel processing info
    parallel_info: Optional[Dict[str, Any]] = None
    # New pause/resume info
    can_pause: bool = True
    can_resume: bool = False
    progress_saved: bool = False
    resume_point: Optional[str] = None


def serialize_genre_cleanup_result(
    result: GenreCleanupResult,
    *,
    debug_mode: bool,
) -> Dict[str, Any]:
    """Convert a genre cleanup result into a JSON-friendly dictionary."""
    payload = {
        "write": result.write,
        "keep_unmapped": result.keep_unmapped,
        "preserve_dropped_as_tags": result.preserve_dropped_as_tags,
        "total_items": result.total_items,
        "changed_count": result.changed_count,
        "updated_count": result.updated_count,
        "error_count": result.error_count,
        "anchor_genres": result.anchor_genres,
        "unmapped_genres": result.unmapped_genres,
        "discarded_genres": result.discarded_genres,
        "changed_items": [
            {
                "id": change.id,
                "title": change.title,
                "before": change.before,
                "after": change.after,
                "before_tags": change.before_tags,
                "after_tags": change.after_tags,
                "added_tags": change.added_tags,
                "mapped": change.mapped,
                "unmapped": change.unmapped,
                "discarded": change.discarded,
                "updated": change.updated,
                "error": change.error,
            }
            for change in result.changed_items
        ],
    }

    if debug_mode:
        payload["diagnostics"] = result.diagnostics
        payload["libraries"] = result.libraries

    return payload


def resolve_abs_connection(
    *,
    abs_url: Optional[str] = None,
    api_token: Optional[str] = None,
):
    """Resolve ABS connection fields from request values plus saved settings."""
    saved_settings = settings_store.load()
    saved_api_token = settings_store.decrypt_api_token(saved_settings)

    resolved_abs_url = (abs_url or saved_settings.abs_url).strip()
    resolved_api_token = (api_token or saved_api_token).strip()

    return saved_settings, resolved_abs_url, resolved_api_token


async def send_progress_update(operation_id: str, update: ProgressUpdate):
    """Send progress update to connected WebSocket clients."""
    if operation_id in websocket_connections:
        try:
            await websocket_connections[operation_id].send_text(update.json())
        except Exception as e:
            logger.error(f"Failed to send progress update: {e}")
            # Remove disconnected WebSocket
            if operation_id in websocket_connections:
                del websocket_connections[operation_id]


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard page."""
    # Provide scan orders with proper values and descriptions
    scan_orders = [
        {"value": "alphabetical", "description": "Alphabetical order (A-Z)"},
        {"value": "reverse", "description": "Reverse alphabetical (Z-A)"},
        {"value": "size-asc", "description": "Smallest directories first"},
        {"value": "size-desc", "description": "Largest directories first"},
        {"value": "recent", "description": "Most recently modified first"},
        {"value": "oldest", "description": "Least recently modified first"},
        {"value": "random", "description": "Random order"},
        {"value": "quarters", "description": "Split into quarters"}
    ]
    
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "scan_orders": scan_orders,
        "anchor_genres": ANCHOR_GENRES,
        "anchor_genre_count": len(ANCHOR_GENRES),
        "genre_mapping_count": len(GENRE_MAPPING),
        "discard_genre_count": len(DISCARD_GENRES),
    })


@app.get("/operations", response_class=HTMLResponse)
async def operations_page(request: Request):
    """Operations monitoring page."""
    return templates.TemplateResponse("operations.html", {
        "request": request,
        "active_operations": active_operations
    })


@app.get("/api/settings")
async def get_settings():
    """Return saved application settings without exposing secrets."""
    try:
        return settings_store.as_public_dict()
    except SettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/settings")
async def save_settings(request: SettingsRequest):
    """Persist application settings, encrypting API token at rest."""
    try:
        settings = settings_store.save(
            abs_url=request.abs_url,
            api_token=request.api_token,
            library_id=request.library_id,
            library_name=request.library_name,
            library_folder=request.library_folder,
            library_media_type=request.library_media_type,
            debug_mode=request.debug_mode,
        )
        return settings_store.as_public_dict(settings)
    except SettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/settings/test-connection")
async def test_abs_connection(request: ConnectionTestRequest):
    """Validate ABS URL/token and return available libraries."""
    try:
        saved_settings, abs_url, api_token = resolve_abs_connection(
            abs_url=request.abs_url,
            api_token=request.api_token,
        )
    except SettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    debug_mode = (
        request.debug_mode
        if request.debug_mode is not None
        else saved_settings.debug_mode
    )

    if not abs_url:
        raise HTTPException(status_code=400, detail="ABS URL is required")
    if not api_token:
        raise HTTPException(status_code=400, detail="API token is required")

    client = ABSMaintenanceClient(abs_url, api_token)

    try:
        libraries = await client.list_libraries()
    except ABSMaintenanceError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(exc),
                "normalized_abs_url": client.base_url,
                "diagnostics": exc.diagnostics if debug_mode else [],
                "debug_mode": debug_mode,
            },
        ) from exc

    payload: Dict[str, Any] = {
        "ok": True,
        "normalized_abs_url": client.base_url,
        "libraries": libraries,
        "library_count": len(libraries),
    }
    if debug_mode:
        payload["diagnostics"] = client.diagnostics
    return payload


@app.post("/api/maintenance/genres/cleanup")
async def cleanup_genres(request: GenreCleanupRequest):
    """Preview or apply ABS genre cleanup through the API."""
    try:
        saved_settings, abs_url, api_token = resolve_abs_connection(
            abs_url=request.abs_url,
            api_token=request.api_token,
        )
    except SettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    library_id = (request.library_id or saved_settings.library_id).strip()
    debug_mode = saved_settings.debug_mode

    if not abs_url:
        raise HTTPException(status_code=400, detail="ABS URL is required")
    if not api_token:
        raise HTTPException(status_code=400, detail="API token is required")
    if not library_id:
        raise HTTPException(status_code=400, detail="Library ID is required")

    client = ABSMaintenanceClient(abs_url, api_token)

    try:
        result = await client.clean_library_genres(
            library_id,
            keep_unmapped=request.keep_unmapped,
            preserve_dropped_as_tags=request.preserve_dropped_as_tags,
            write=request.write,
        )
    except ABSMaintenanceError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(exc),
                "normalized_abs_url": client.base_url,
                "diagnostics": exc.diagnostics if debug_mode else [],
                "debug_mode": debug_mode,
            },
        ) from exc

    return serialize_genre_cleanup_result(result, debug_mode=debug_mode)


@app.get("/api/browse")
async def browse_directories(
    path: str = Query("/", description="Directory path to browse"),
    show_hidden: bool = Query(False, description="Show hidden directories")
):
    """Browse directories for path selection."""
    try:
        browse_path = Path(path)
        
        # Security check - prevent browsing outside reasonable bounds
        if not browse_path.is_absolute():
            browse_path = Path("/") / browse_path
        
        if not browse_path.exists():
            raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")
        
        if not browse_path.is_dir():
            raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")
        
        # Get directory contents
        try:
            items = []
            
            # Add parent directory link (except for root)
            if browse_path != Path("/") and browse_path.parent != browse_path:
                items.append({
                    "name": ".. (Parent Directory)",
                    "path": str(browse_path.parent),
                    "type": "parent",
                    "is_dir": True,
                    "size": None,
                    "modified": None
                })
            
            # Get subdirectories
            for item in sorted(browse_path.iterdir()):
                # Skip hidden files unless requested
                if item.name.startswith('.') and not show_hidden:
                    continue
                
                # Only include directories
                if item.is_dir():
                    try:
                        stat = item.stat()
                        items.append({
                            "name": item.name,
                            "path": str(item),
                            "type": "directory",
                            "is_dir": True,
                            "size": None,
                            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                        })
                    except (PermissionError, OSError):
                        # Skip directories we can't access
                        continue
            
            return {
                "current_path": str(browse_path),
                "parent_path": str(browse_path.parent) if browse_path.parent != browse_path else None,
                "items": items,
                "total_items": len(items)
            }
            
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error browsing directory {path}: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.get("/api/browse/common")
async def get_common_directories():
    """Get common directory paths for quick selection."""
    common_paths = [
        {
            "name": "Home Directory",
            "path": str(Path.home()),
            "description": "User home directory"
        },
        {
            "name": "Desktop",
            "path": str(Path.home() / "Desktop"),
            "description": "Desktop folder"
        },
        {
            "name": "Documents",
            "path": str(Path.home() / "Documents"),
            "description": "Documents folder"
        },
        {
            "name": "Downloads",
            "path": str(Path.home() / "Downloads"),
            "description": "Downloads folder"
        },
        {
            "name": "Root",
            "path": "/",
            "description": "System root directory"
        }
    ]
    
    # Filter to only existing directories
    existing_paths = []
    for path_info in common_paths:
        if Path(path_info["path"]).exists():
            existing_paths.append(path_info)
    
    return {"common_paths": existing_paths}


@app.websocket("/ws/{operation_id}")
async def websocket_endpoint(websocket: WebSocket, operation_id: str):
    """WebSocket endpoint for real-time progress updates."""
    await websocket.accept()
    websocket_connections[operation_id] = websocket
    logger.info(f"WebSocket connected for operation {operation_id}")
    
    try:
        # Send initial connection confirmation
        await websocket.send_text(json.dumps({
            "type": "connection",
            "operation_id": operation_id,
            "message": "Connected to AudioShelf Librarian"
        }))
        
        # Keep connection alive and handle client messages
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Handle cancellation requests
            if message.get("type") == "cancel":
                if operation_id in active_operations:
                    active_operations[operation_id]["cancelled"] = True
                    await websocket.send_text(json.dumps({
                        "type": "cancellation",
                        "message": "Cancellation requested - finishing current operations..."
                    }))
                    
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for operation {operation_id}")
    finally:
        if operation_id in websocket_connections:
            del websocket_connections[operation_id]


@app.post("/api/scan")
async def start_scan(scan_request: ScanRequest):
    """Start a new scan operation."""
    operation_id = str(uuid.uuid4())
    
    logger.info(f"Starting scan operation {operation_id} for path: {scan_request.path}")
    
    try:
        # Validate paths
        scan_path = Path(scan_request.path)
        if not scan_path.exists():
            raise HTTPException(status_code=400, detail=f"Scan path does not exist: {scan_request.path}")
        
        if not scan_path.is_dir():
            raise HTTPException(status_code=400, detail=f"Scan path is not a directory: {scan_request.path}")
        
        # Validate library path
        library_path = Path(scan_request.library_path)
        if not library_path.parent.exists():
            raise HTTPException(status_code=400, detail=f"Library path parent directory does not exist: {scan_request.library_path}")
        
        # Validate scan order
        try:
            # Convert any hyphens to underscores and check if valid
            normalized_order = scan_request.scan_order.replace('-', '_').upper()
            if not hasattr(ScanOrder, normalized_order):
                # Try to find a matching order value
                valid_orders = [order.value for order in ScanOrder]
                if scan_request.scan_order not in valid_orders:
                    raise ValueError(f"Invalid scan order. Valid options: {valid_orders}")
        except (ValueError, AttributeError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid scan order '{scan_request.scan_order}': {str(e)}")
        
        # Validate max_workers
        if scan_request.max_workers is not None and (scan_request.max_workers < 1 or scan_request.max_workers > 32):
            raise HTTPException(status_code=400, detail=f"Max workers must be between 1 and 32, got: {scan_request.max_workers}")
        
        # Create operation record
        active_operations[operation_id] = {
            "id": operation_id,
            "type": "scan",
            "status": "starting",
            "request": scan_request.dict(),
            "started_at": datetime.now(),
            "cancelled": False,
            "books": [],
            "actions": [],
            "progress": {
                "completed": 0,
                "total": 0,
                "current_item": "",
                "progress_pct": 0.0
            }
        }
        
        # Start scan in background
        asyncio.create_task(execute_scan_operation(operation_id, scan_request))
        
        return {
            "operation_id": operation_id,
            "status": "started",
            "message": f"Scan operation started for {scan_request.path}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to start scan operation: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


async def execute_scan_operation(operation_id: str, scan_request: ScanRequest):
    """Execute scan operation with progress updates."""
    try:
        operation = active_operations[operation_id]
        operation["status"] = "running"
        
        # Create configuration
        config = create_default_config()
        config.library_path = Path(scan_request.library_path)
        
        # Set up scan strategy
        strategy = ScanStrategy()
        scan_order_enum = ScanOrder(scan_request.scan_order)
        
        # Find directories to scan
        scan_path = Path(scan_request.path)
        if scan_path.is_dir():
            subdirs = [item for item in scan_path.iterdir() 
                      if item.is_dir() and not item.name.startswith('.')]
        else:
            subdirs = []
        
        if not subdirs:
            operation["status"] = "completed"
            operation["message"] = "No directories found to scan"
            return
        
        # Apply scan ordering
        ordered_subdirs = strategy.order_directories(subdirs, scan_order_enum, scan_request.resume_from)
        
        # Update operation with directory info
        operation["total_directories"] = len(ordered_subdirs)
        operation["estimated_time"] = f"~{len(ordered_subdirs) // 10 + 1} minutes"
        
        # Send initial progress update
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="scan",
            progress_pct=0.0,
            current_item="Starting scan...",
            completed=0,
            total=len(ordered_subdirs),
            elapsed_time=0.0,
            eta_seconds=len(ordered_subdirs) * 2,  # Rough estimate: 2 seconds per directory
            scan_strategy=scan_request.scan_order,
            status="running"
        ))
        
        # Create progress callback
        start_time = time.time()
        
        async def progress_callback(progress_data):
            if operation.get("cancelled"):
                return
                
            elapsed = time.time() - start_time
            
            # Update operation progress
            operation["progress"] = {
                "completed": progress_data.get("completed", 0),
                "total": progress_data.get("total", 0),
                "current_item": progress_data.get("current_item", ""),
                "progress_pct": progress_data.get("progress_pct", 0.0),
                "elapsed_time": elapsed
            }
            
            # Send WebSocket update
            await send_progress_update(operation_id, ProgressUpdate(
                operation_id=operation_id,
                operation_type="scan",
                progress_pct=progress_data.get("progress_pct", 0.0),
                current_item=progress_data.get("current_item", ""),
                completed=progress_data.get("completed", 0),
                total=progress_data.get("total", 0),
                elapsed_time=elapsed,
                eta_seconds=progress_data.get("eta_seconds", 0.0),
                scan_strategy=scan_request.scan_order,
                books_found=len(operation.get("books", [])),
                status="running"
            ))
        
        # Execute scanning
        if scan_request.parallel and len(ordered_subdirs) > 1:
            processor = create_parallel_processor(config, scan_request.max_workers)
            
            # Custom progress callback for web interface
            def sync_progress_callback(progress_data):
                # Convert sync callback to async
                asyncio.create_task(progress_callback(progress_data))
            
            books = processor.scan_directories_parallel(ordered_subdirs, sync_progress_callback)
        else:
            # Sequential scanning with manual progress updates
            books = []
            for i, directory in enumerate(ordered_subdirs):
                if operation.get("cancelled"):
                    break
                
                try:
                    # Update progress
                    await progress_callback({
                        "completed": i,
                        "total": len(ordered_subdirs),
                        "current_item": directory.name,
                        "progress_pct": (i / len(ordered_subdirs)) * 100,
                        "eta_seconds": 0.0
                    })
                    
                    # Scan directory
                    dir_books = scan_directory_for_books(directory, config)
                    books.extend(dir_books)
                    
                except Exception as e:
                    logger.error(f"Error scanning directory {directory}: {e}")
                    continue
        
        # Store results
        operation["books"] = [book.dict() for book in books]
        operation["books_found"] = len(books)
        
        # Generate organization actions
        if books and not operation.get("cancelled"):
            organizer = LibraryOrganizer(config)
            actions = organizer.organize_library(books)
            operation["actions"] = [action.dict() for action in actions]
        
        # Mark as completed
        if operation.get("cancelled"):
            operation["status"] = "cancelled"
            await send_progress_update(operation_id, ProgressUpdate(
                operation_id=operation_id,
                operation_type="scan",
                progress_pct=operation["progress"]["progress_pct"],
                current_item="Operation cancelled",
                completed=operation["progress"]["completed"],
                total=operation["progress"]["total"],
                elapsed_time=time.time() - start_time,
                eta_seconds=0.0,
                scan_strategy=scan_request.scan_order,
                books_found=len(books),
                status="cancelled"
            ))
        else:
            operation["status"] = "completed"
            operation["completed_at"] = datetime.now()
            
            await send_progress_update(operation_id, ProgressUpdate(
                operation_id=operation_id,
                operation_type="scan",
                progress_pct=100.0,
                current_item="Scan completed",
                completed=operation["progress"]["total"],
                total=operation["progress"]["total"],
                elapsed_time=time.time() - start_time,
                eta_seconds=0.0,
                scan_strategy=scan_request.scan_order,
                books_found=len(books),
                status="completed"
            ))
        
    except Exception as e:
        logger.error(f"Scan operation {operation_id} failed: {e}")
        operation["status"] = "error"
        operation["error"] = str(e)
        
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="scan",
            progress_pct=0.0,
            current_item=f"Error: {str(e)}",
            completed=0,
            total=0,
            elapsed_time=0.0,
            eta_seconds=0.0,
            status="error"
        ))


@app.post("/api/organize")
async def start_organize(organize_request: OrganizeRequest):
    """Start a new organize operation (inbox processing)."""
    operation_id = str(uuid.uuid4())
    
    logger.info(f"Starting organize operation {operation_id}")
    
    try:
        # Validate paths
        inbox_path = Path(organize_request.inbox_path)
        if not inbox_path.exists():
            raise HTTPException(status_code=400, detail=f"Inbox path does not exist: {organize_request.inbox_path}")
        
        if not inbox_path.is_dir():
            raise HTTPException(status_code=400, detail=f"Inbox path is not a directory: {organize_request.inbox_path}")
        
        # Validate library path
        library_path = Path(organize_request.library_path)
        if not library_path.parent.exists():
            raise HTTPException(status_code=400, detail=f"Library path parent directory does not exist: {organize_request.library_path}")
        
        # Create operation record
        active_operations[operation_id] = {
            "id": operation_id,
            "type": "organize", 
            "status": "starting",
            "request": organize_request.dict(),
            "started_at": datetime.now(),
            "cancelled": False,
            "books": [],
            "actions": [],
            "progress": {
                "completed": 0,
                "total": 0,
                "current_item": "",
                "progress_pct": 0.0
            }
        }
        
        # Start organize in background
        asyncio.create_task(execute_organize_operation(operation_id, organize_request))
        
        return {
            "operation_id": operation_id,
            "status": "started",
            "message": f"Organize operation started for inbox: {organize_request.inbox_path}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to start organize operation: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


async def execute_organize_operation(operation_id: str, organize_request: OrganizeRequest):
    """Execute organize operation (similar to scan but focused on inbox)."""
    # Similar implementation to execute_scan_operation but for inbox processing
    # This would scan the inbox and generate organization actions
    pass  # Implementation similar to scan but shorter since it's inbox-focused


@app.get("/api/operations/{operation_id}")
async def get_operation_status(operation_id: str):
    """Get current status of an operation."""
    if operation_id not in active_operations:
        raise HTTPException(status_code=404, detail="Operation not found")
    
    return active_operations[operation_id]


@app.get("/api/operations")
async def list_operations():
    """List all operations."""
    return {"operations": list(active_operations.values())}


@app.post("/api/operations/{operation_id}/pause")
async def pause_operation(operation_id: str):
    """Pause a running operation and save progress."""
    if operation_id not in active_operations:
        raise HTTPException(status_code=404, detail="Operation not found")
    
    operation = active_operations[operation_id]
    if operation["status"] not in ["running"]:
        raise HTTPException(status_code=400, detail=f"Cannot pause operation with status: {operation['status']}")
    
    # Set pause flag
    operation["paused"] = True
    operation["status"] = "pausing"
    operation["pause_requested_at"] = datetime.now()
    
    # Save progress if scanning operation
    if operation["type"] in ["scan", "organize"]:
        try:
            await save_operation_progress(operation_id)
            operation["progress_saved"] = True
        except Exception as e:
            logger.warning(f"Failed to save progress for operation {operation_id}: {e}")
    
    return {"message": "Pause requested - operation will pause after current task"}


@app.post("/api/operations/{operation_id}/resume")
async def resume_operation(operation_id: str):
    """Resume a paused operation."""
    if operation_id not in active_operations:
        raise HTTPException(status_code=404, detail="Operation not found")
    
    operation = active_operations[operation_id]
    if operation["status"] != "paused":
        raise HTTPException(status_code=400, detail=f"Cannot resume operation with status: {operation['status']}")
    
    # Clear pause flag and resume
    operation["paused"] = False
    operation["status"] = "running"
    operation["resumed_at"] = datetime.now()
    
    # Continue the operation from where it left off
    if operation["type"] == "scan":
        scan_request = ScanRequest(**operation["request"])
        asyncio.create_task(execute_scan_operation(operation_id, scan_request, resume=True))
    elif operation["type"] == "organize":
        organize_request = OrganizeRequest(**operation["request"])
        asyncio.create_task(execute_organize_operation(operation_id, organize_request, resume=True))
    
    return {"message": "Operation resumed"}


async def save_operation_progress(operation_id: str):
    """Save operation progress to file for resume functionality."""
    import json
    from pathlib import Path
    
    operation = active_operations.get(operation_id)
    if not operation:
        return
    
    progress_file = Path(f".audioshelf_scan_progress_{operation_id}.json")
    
    progress_data = {
        "operation_id": operation_id,
        "operation_type": operation["type"],
        "request": operation["request"],
        "started_at": operation["started_at"].isoformat(),
        "paused_at": datetime.now().isoformat(),
        "progress": operation.get("progress", {}),
        "books_found": operation.get("books_found", 0),
        "current_directory": operation.get("progress", {}).get("current_item", ""),
        "completed_directories": operation.get("progress", {}).get("completed", 0),
        "total_directories": operation.get("total_directories", 0),
        "books": operation.get("books", []),
        "actions": operation.get("actions", [])
    }
    
    with open(progress_file, 'w') as f:
        json.dump(progress_data, f, indent=2, default=str)
    
    logger.info(f"Progress saved to {progress_file}")


@app.get("/api/progress-files")
async def list_progress_files():
    """List available progress files for resuming operations."""
    from pathlib import Path
    import json
    
    progress_files = []
    for file_path in Path(".").glob(".audioshelf_scan_progress_*.json"):
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
                
            progress_files.append({
                "filename": file_path.name,
                "operation_id": data.get("operation_id"),
                "operation_type": data.get("operation_type"),
                "started_at": data.get("started_at"),
                "paused_at": data.get("paused_at"),
                "progress_pct": data.get("progress", {}).get("progress_pct", 0),
                "completed": data.get("completed_directories", 0),
                "total": data.get("total_directories", 0),
                "books_found": data.get("books_found", 0),
                "current_directory": data.get("current_directory", "")
            })
        except Exception as e:
            logger.warning(f"Failed to read progress file {file_path}: {e}")
    
    return {"progress_files": progress_files}


@app.post("/api/resume-from-file")
async def resume_from_progress_file(filename: str = Form(...)):
    """Resume an operation from a saved progress file."""
    from pathlib import Path
    import json
    
    progress_file = Path(filename)
    if not progress_file.exists():
        raise HTTPException(status_code=404, detail="Progress file not found")
    
    try:
        with open(progress_file, 'r') as f:
            progress_data = json.load(f)
        
        # Create new operation based on saved progress
        operation_id = str(uuid.uuid4())
        
        # Restore the operation state
        active_operations[operation_id] = {
            "id": operation_id,
            "type": progress_data["operation_type"],
            "status": "resuming",
            "request": progress_data["request"],
            "started_at": datetime.now(),
            "resumed_from_file": filename,
            "original_start": progress_data["started_at"],
            "books": progress_data.get("books", []),
            "actions": progress_data.get("actions", []),
            "progress": progress_data.get("progress", {}),
            "books_found": progress_data.get("books_found", 0),
            "total_directories": progress_data.get("total_directories", 0)
        }
        
        # Resume the appropriate operation type
        if progress_data["operation_type"] == "scan":
            scan_request = ScanRequest(**progress_data["request"])
            # Set resume point to continue from where we left off
            scan_request.resume_from = progress_data.get("current_directory")
            asyncio.create_task(execute_scan_operation(operation_id, scan_request, resume=True))
        elif progress_data["operation_type"] == "organize":
            organize_request = OrganizeRequest(**progress_data["request"])
            asyncio.create_task(execute_organize_operation(operation_id, organize_request, resume=True))
        
        return {
            "operation_id": operation_id,
            "message": f"Operation resumed from {filename}",
            "original_start": progress_data["started_at"],
            "books_found": progress_data.get("books_found", 0)
        }
        
    except Exception as e:
        logger.error(f"Failed to resume from progress file {filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to resume operation: {str(e)}")


@app.post("/api/execute")
async def execute_actions(execute_request: ExecuteRequest):
    """Execute confirmed organization actions."""
    operation_id = execute_request.operation_id
    
    if operation_id not in active_operations:
        raise HTTPException(status_code=404, detail="Operation not found")
    
    operation = active_operations[operation_id]
    actions = operation.get("actions", [])
    
    if not actions:
        raise HTTPException(status_code=400, detail="No actions available to execute")
    
    # Create new execution operation
    exec_operation_id = str(uuid.uuid4())
    active_operations[exec_operation_id] = {
        "id": exec_operation_id,
        "type": "execute",
        "status": "running",
        "parent_operation": operation_id,
        "started_at": datetime.now(),
        "cancelled": False,
        "actions_executed": 0,
        "total_actions": len(execute_request.confirmed_actions)
    }
    
    # Start execution in background
    asyncio.create_task(execute_file_operations(exec_operation_id, actions, execute_request.confirmed_actions))
    
    return {
        "execution_id": exec_operation_id,
        "status": "started",
        "message": f"Executing {len(execute_request.confirmed_actions)} organization actions"
    }


async def execute_file_operations(operation_id: str, all_actions: List[Dict], action_indices: List[int]):
    """
    Execute actual file operations with progress updates.
    
    This performs the actual file moving/renaming operations based on the
    organization actions, with real-time progress updates via WebSocket.
    """
    import shutil
    from .models import ActionType
    
    try:
        operation = active_operations[operation_id]
        operation["status"] = "running"
        
        start_time = time.time()
        success_count = 0
        error_count = 0
        
        # Filter actions to execute
        actions_to_execute = [all_actions[i] for i in action_indices if i < len(all_actions)]
        
        for i, action_dict in enumerate(actions_to_execute):
            if operation.get("cancelled"):
                break
            
            try:
                # Send progress update
                progress_pct = (i / len(actions_to_execute)) * 100
                current_item = f"{action_dict.get('book', {}).get('title', 'Unknown')} by {action_dict.get('book', {}).get('authors', ['Unknown'])[0]}"
                
                await send_progress_update(operation_id, ProgressUpdate(
                    operation_id=operation_id,
                    operation_type="execute",
                    progress_pct=progress_pct,
                    current_item=current_item,
                    completed=i,
                    total=len(actions_to_execute),
                    elapsed_time=time.time() - start_time,
                    eta_seconds=0.0,
                    status="running"
                ))
                
                # Extract action details
                action_type = action_dict.get("action_type")
                source_path = Path(action_dict.get("source_path"))
                target_path = Path(action_dict.get("target_path"))
                
                # Ensure target directory exists
                target_path.parent.mkdir(parents=True, exist_ok=True)
                
                # Perform the file operation
                if action_type == "move":
                    if source_path.exists():
                        shutil.move(str(source_path), str(target_path))
                        success_count += 1
                        logger.info(f"Moved: {source_path} → {target_path}")
                    else:
                        logger.warning(f"Source path does not exist: {source_path}")
                        error_count += 1
                        
                elif action_type == "rename":
                    if source_path.exists():
                        source_path.rename(target_path)
                        success_count += 1
                        logger.info(f"Renamed: {source_path} → {target_path}")
                    else:
                        logger.warning(f"Source path does not exist: {source_path}")
                        error_count += 1
                
                # Update operation progress
                operation["actions_executed"] = i + 1
                
            except Exception as e:
                error_count += 1
                logger.error(f"Failed to execute action {i}: {e}")
                
                # Send error update but continue with other actions
                await send_progress_update(operation_id, ProgressUpdate(
                    operation_id=operation_id,
                    operation_type="execute",
                    progress_pct=(i / len(actions_to_execute)) * 100,
                    current_item=f"Error: {str(e)[:50]}...",
                    completed=i,
                    total=len(actions_to_execute),
                    elapsed_time=time.time() - start_time,
                    eta_seconds=0.0,
                    status="error"
                ))
                
                # Brief pause before continuing
                await asyncio.sleep(0.1)
        
        # Final status update
        final_status = "cancelled" if operation.get("cancelled") else "completed"
        operation["status"] = final_status
        operation["completed_at"] = datetime.now()
        operation["success_count"] = success_count
        operation["error_count"] = error_count
        
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="execute",
            progress_pct=100.0,
            current_item=f"Completed: {success_count} successful, {error_count} errors",
            completed=len(actions_to_execute),
            total=len(actions_to_execute),
            elapsed_time=time.time() - start_time,
            eta_seconds=0.0,
            status=final_status
        ))
        
        logger.info(f"File operations completed: {success_count} successful, {error_count} errors")

        # ------------------------------------------------------------------ #
        # ABS Rescan — notify ABS that paths have changed so its database     #
        # stays in sync.  We attempt this only when ABS connection settings   #
        # are fully configured AND at least one file was successfully moved.  #
        # ------------------------------------------------------------------ #
        if success_count > 0 and final_status == "completed":
            try:
                saved_settings = settings_store.load()
                api_token = settings_store.decrypt_api_token(saved_settings)
                if (
                    saved_settings.abs_url
                    and saved_settings.library_id
                    and api_token
                ):
                    client = ABSMaintenanceClient(saved_settings.abs_url, api_token)
                    triggered = await client.trigger_library_scan(saved_settings.library_id)
                    if triggered:
                        logger.info(
                            f"ABS library scan triggered for library {saved_settings.library_id}"
                        )
                        operation["abs_rescan_triggered"] = True
                    else:
                        logger.warning(
                            "ABS rescan request was not accepted by the server"
                        )
                        operation["abs_rescan_triggered"] = False
            except Exception as exc:
                logger.warning(f"Could not trigger ABS rescan (non-fatal): {exc}")
                operation["abs_rescan_triggered"] = False


    except Exception as e:
        logger.error(f"Execute operation {operation_id} failed: {e}")
        operation["status"] = "error"
        operation["error"] = str(e)
        
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="execute",
            progress_pct=0.0,
            current_item=f"Fatal error: {str(e)}",
            completed=0,
            total=0,
            elapsed_time=0.0,
            eta_seconds=0.0,
            status="error"
        ))


async def execute_organize_operation(operation_id: str, organize_request: OrganizeRequest):
    """
    Execute organize operation (inbox processing) with progress updates.
    
    This scans the inbox directory and generates organization actions,
    similar to the scan operation but focused on inbox-to-library workflow.
    """
    try:
        operation = active_operations[operation_id]
        operation["status"] = "running"
        
        # Create configuration
        config = create_default_config()
        config.library_path = Path(organize_request.library_path)
        config.inbox_path = Path(organize_request.inbox_path)
        
        # Set up scan strategy
        strategy = ScanStrategy()
        scan_order_enum = ScanOrder(organize_request.scan_order)
        
        # Find inbox items
        inbox_path = Path(organize_request.inbox_path)
        if inbox_path.is_dir():
            inbox_items = [item for item in inbox_path.iterdir() 
                          if item.is_dir() and not item.name.startswith('.')]
        else:
            inbox_items = []
        
        if not inbox_items:
            operation["status"] = "completed"
            operation["message"] = "No items found in inbox"
            await send_progress_update(operation_id, ProgressUpdate(
                operation_id=operation_id,
                operation_type="organize",
                progress_pct=100.0,
                current_item="No items found in inbox",
                completed=0,
                total=0,
                elapsed_time=0.0,
                eta_seconds=0.0,
                status="completed"
            ))
            return
        
        # Apply scan ordering
        ordered_items = strategy.order_directories(inbox_items, scan_order_enum)
        operation["total_directories"] = len(ordered_items)
        
        # Send initial progress update
        start_time = time.time()
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="organize",
            progress_pct=0.0,
            current_item="Starting inbox processing...",
            completed=0,
            total=len(ordered_items),
            elapsed_time=0.0,
            eta_seconds=0.0,
            scan_strategy=organize_request.scan_order,
            status="running"
        ))
        
        # Process inbox items
        books = []
        for i, directory in enumerate(ordered_items):
            if operation.get("cancelled"):
                break
            
            try:
                # Update progress
                progress_pct = (i / len(ordered_items)) * 100
                await send_progress_update(operation_id, ProgressUpdate(
                    operation_id=operation_id,
                    operation_type="organize",
                    progress_pct=progress_pct,
                    current_item=directory.name,
                    completed=i,
                    total=len(ordered_items),
                    elapsed_time=time.time() - start_time,
                    eta_seconds=0.0,
                    scan_strategy=organize_request.scan_order,
                    books_found=len(books),
                    status="running"
                ))
                
                # Scan directory for books
                dir_books = scan_directory_for_books(directory, config)
                books.extend(dir_books)
                
            except Exception as e:
                logger.error(f"Error scanning inbox directory {directory}: {e}")
                continue
        
        # Store results and generate actions
        operation["books"] = [book.dict() for book in books]
        operation["books_found"] = len(books)
        
        if books and not operation.get("cancelled"):
            organizer = LibraryOrganizer(config)
            actions = organizer.organize_library(books)
            operation["actions"] = [action.dict() for action in actions]
            
            # If auto_confirm is enabled, execute actions immediately
            if organize_request.auto_confirm and actions:
                executable_actions = [
                    i for i, action in enumerate(actions) 
                    if action.action_type in (ActionType.MOVE, ActionType.RENAME) and action.will_change_location
                ]
                
                if executable_actions:
                    # Start execution in background
                    exec_operation_id = str(uuid.uuid4())
                    active_operations[exec_operation_id] = {
                        "id": exec_operation_id,
                        "type": "execute",
                        "status": "running",
                        "parent_operation": operation_id,
                        "started_at": datetime.now(),
                        "cancelled": False,
                        "actions_executed": 0,
                        "total_actions": len(executable_actions)
                    }
                    
                    asyncio.create_task(execute_file_operations(exec_operation_id, actions, executable_actions))
        
        # Mark as completed
        final_status = "cancelled" if operation.get("cancelled") else "completed"
        operation["status"] = final_status
        operation["completed_at"] = datetime.now()
        
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="organize",
            progress_pct=100.0,
            current_item="Inbox processing completed" if final_status == "completed" else "Operation cancelled",
            completed=len(ordered_items),
            total=len(ordered_items),
            elapsed_time=time.time() - start_time,
            eta_seconds=0.0,
            scan_strategy=organize_request.scan_order,
            books_found=len(books),
            status=final_status
        ))
        
    except Exception as e:
        logger.error(f"Organize operation {operation_id} failed: {e}")
        operation["status"] = "error"
        operation["error"] = str(e)
        
        await send_progress_update(operation_id, ProgressUpdate(
            operation_id=operation_id,
            operation_type="organize",
            progress_pct=0.0,
            current_item=f"Error: {str(e)}",
            completed=0,
            total=0,
            elapsed_time=0.0,
            eta_seconds=0.0,
            status="error"
        ))


if __name__ == "__main__":
    uvicorn.run(
        "audioshelf_librarian.web_app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
