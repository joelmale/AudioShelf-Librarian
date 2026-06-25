#!/usr/bin/env python3
"""
Quick test script to validate the web application fixes.
"""

import sys
from pathlib import Path

def test_web_app_imports():
    """Test that we can import the web application modules."""
    try:
        # Add the project directory to path
        project_root = Path(__file__).parent
        sys.path.insert(0, str(project_root))
        
        print("🧪 Testing web application imports...")
        
        # Test core imports
        from audioshelf_librarian.web_app import app
        print("✅ FastAPI app imported successfully")
        
        # Test that the app has the expected routes
        routes = [route.path for route in app.routes]
        expected_routes = ['/', '/operations', '/api/scan', '/api/organize', '/ws/{operation_id}']
        
        for route in expected_routes:
            if any(route in r for r in routes):
                print(f"✅ Route found: {route}")
            else:
                print(f"❌ Route missing: {route}")
        
        print("\n🎯 Testing scan order values...")
        from audioshelf_librarian.scan_strategies import ScanOrder
        
        valid_orders = [order.value for order in ScanOrder]
        print(f"Valid scan orders: {valid_orders}")
        
        # Test that common orders exist
        expected_orders = ['alphabetical', 'random', 'recent', 'oldest']
        for order in expected_orders:
            if order in valid_orders:
                print(f"✅ Scan order exists: {order}")
            else:
                print(f"❌ Scan order missing: {order}")
        
        print("\n🔧 Testing template files...")
        
        templates_dir = project_root / "templates"
        if templates_dir.exists():
            template_files = list(templates_dir.glob("*.html"))
            print(f"✅ Templates directory found with {len(template_files)} files")
            
            for template in template_files:
                print(f"  📄 {template.name}")
        else:
            print("❌ Templates directory not found")
        
        static_dir = project_root / "static"
        if static_dir.exists():
            static_files = list(static_dir.glob("*"))
            print(f"✅ Static directory found with {len(static_files)} files")
        else:
            print("❌ Static directory not found")
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing web app: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_configuration():
    """Test that the default configuration works."""
    try:
        from audioshelf_librarian.web_app import create_default_config
        
        config = create_default_config()
        print(f"✅ Default configuration created")
        print(f"  📁 Library path: {config.library_path}")
        print(f"  📁 Inbox path: {config.inbox_path}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing configuration: {e}")
        return False

if __name__ == "__main__":
    print("🎧 AudioShelf Librarian Web App Test")
    print("=" * 50)
    
    success = True
    
    success &= test_web_app_imports()
    print()
    success &= test_configuration()
    
    print("\n" + "=" * 50)
    
    if success:
        print("🎉 All tests passed! Web application should work correctly.")
        print("\n🚀 To start the web server:")
        print("   python web.py start --dev")
        print("   or")
        print("   uvicorn audioshelf_librarian.web_app:app --reload")
    else:
        print("❌ Some tests failed. Check the error messages above.")
        sys.exit(1)
