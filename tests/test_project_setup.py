#!/usr/bin/env python3
"""
Quick startup script for testing AudioShelf Librarian Enhanced Web Interface.
"""

import sys
from pathlib import Path

# Add project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

def main():
    print("🎧 AudioShelf Librarian - Enhanced Web Interface")
    print("=" * 60)
    print("🚀 Starting development server with enhanced features:")
    print("   ✅ Pause/Resume functionality")
    print("   ✅ Parallel processing visualization")
    print("   ✅ Smart progress saving")
    print("   ✅ Real-time worker statistics")
    print()
    print("🌐 Server will be available at: http://localhost:8000")
    print("📁 Using enhanced dashboard template")
    print()
    
    try:
        import uvicorn
        
        # Start the enhanced web application
        uvicorn.run(
            "audioshelf_librarian.web_app_enhanced:app",
            host="0.0.0.0",
            port=8000,
            reload=True,
            log_level="info"
        )
        
    except ImportError:
        print("❌ uvicorn not found. Please install: pip install uvicorn")
        return 1
    except Exception as e:
        print(f"❌ Failed to start server: {e}")
        return 1

if __name__ == "__main__":
    exit(main())
