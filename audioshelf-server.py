#!/usr/bin/env python3
"""
AudioShelf Librarian Web Server

Starts the FastAPI web application with production-ready settings.
Provides both development and production modes with appropriate configurations.
"""

import sys
import logging
from pathlib import Path
import uvicorn
import typer

# Add the project directory to Python path for proper imports
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

app = typer.Typer(help="AudioShelf Librarian Web Server")

@app.command()
def start(
    host: str = typer.Option("0.0.0.0", help="Host to bind to"),
    port: int = typer.Option(8000, help="Port to bind to"),
    dev: bool = typer.Option(False, help="Enable development mode with auto-reload"),
    log_level: str = typer.Option("info", help="Log level (debug, info, warning, error)"),
    workers: int = typer.Option(1, help="Number of worker processes (production only)")
):
    """
    Start the AudioShelf Librarian web server.
    
    Examples:
        python web.py start                    # Start on default port 8000
        python web.py start --port 3000 --dev  # Development mode on port 3000
        python web.py start --workers 4        # Production with 4 workers
    """
    
    # Configure logging
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    print(f"🎧 Starting AudioShelf Librarian Web Server")
    print(f"🌐 Server will be available at: http://{host}:{port}")
    print(f"📁 Templates directory: {project_root}/templates")
    print(f"📁 Static files directory: {project_root}/static")
    
    if dev:
        print("🔧 Development mode: Auto-reload enabled")
        # Development mode with auto-reload
        uvicorn.run(
            "audioshelf_librarian.web_app:app",
            host=host,
            port=port,
            reload=True,
            log_level=log_level,
            access_log=True,
            reload_dirs=[str(project_root)]
        )
    else:
        print(f"🚀 Production mode: {workers} worker{'s' if workers != 1 else ''}")
        # Production mode
        uvicorn.run(
            "audioshelf_librarian.web_app:app",
            host=host,
            port=port,
            workers=workers,
            log_level=log_level,
            access_log=True
        )

@app.command()
def test():
    """Test that the web application can start properly."""
    try:
        from audioshelf_librarian.web_app import app as fastapi_app
        print("✅ FastAPI application imported successfully")
        
        # Test that templates directory exists
        templates_dir = project_root / "templates"
        if templates_dir.exists():
            print("✅ Templates directory found")
            template_files = list(templates_dir.glob("*.html"))
            print(f"   Found {len(template_files)} template files: {[f.name for f in template_files]}")
        else:
            print("❌ Templates directory not found")
            return False
        
        # Test that static directory exists
        static_dir = project_root / "static" 
        if static_dir.exists():
            print("✅ Static files directory found")
            static_files = list(static_dir.glob("*"))
            print(f"   Found {len(static_files)} static files: {[f.name for f in static_files]}")
        else:
            print("❌ Static files directory not found")
            return False
            
        print("✅ Web application test passed!")
        print("\n🚀 Ready to start the server with: python web.py start --dev")
        return True
        
    except ImportError as e:
        print(f"❌ Failed to import web application: {e}")
        print("   Make sure all dependencies are installed: pip install -r requirements.txt")
        return False
    except Exception as e:
        print(f"❌ Web application test failed: {e}")
        return False

@app.command()
def info():
    """Show information about the web application."""
    print("🎧 AudioShelf Librarian Web Application")
    print("=" * 50)
    print(f"📍 Project root: {project_root}")
    print(f"📍 Templates: {project_root}/templates")
    print(f"📍 Static files: {project_root}/static")
    print()
    print("🚀 Available endpoints:")
    print("   GET  /              - Main dashboard")
    print("   GET  /operations    - Operations monitor")
    print("   POST /api/scan      - Start scan operation")
    print("   POST /api/organize  - Start organize operation")
    print("   WS   /ws/{id}       - WebSocket progress updates")
    print()
    print("📚 Usage:")
    print("   python web.py start --dev    # Development mode")
    print("   python web.py start          # Production mode")
    print("   python web.py test           # Test configuration")

if __name__ == "__main__":
    app()
