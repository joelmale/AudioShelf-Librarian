#!/usr/bin/env python3
"""
Test script for signal handling and progress tracking.

This creates a simple test to verify that Ctrl+C cancellation
works properly and progress tracking is accurate.
"""

import sys
import time
from pathlib import Path

# Add the project directory to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from audioshelf_librarian.parallel import CancellableOperation, ProgressTracker


def simulate_long_operation():
    """
    Simulate a long-running operation to test cancellation.

    This mimics scanning many audiobook directories with
    realistic timing and progress updates.
    """
    print("🎧 Testing AudioShelf Librarian signal handling...")
    print("Press Ctrl+C at any time to test graceful cancellation.\n")

    # Simulate scanning 20 directories
    total_items = 20
    items = [f"Directory_{i:02d}" for i in range(1, total_items + 1)]

    progress_tracker = ProgressTracker(total_items, "Testing cancellation")
    cancellable_op = CancellableOperation(progress_tracker)

    try:
        for i, item in enumerate(items):
            if not cancellable_op.should_continue():
                print(f"\nℹ️  Cancellation detected at item {i+1}/{total_items}")
                break

            # Simulate work (like scanning a directory)
            print(f"Processing {item}... ", end="", flush=True)

            # Simulate varying processing times
            processing_time = 0.5 + (i % 3) * 0.3  # 0.5-1.1 seconds per item
            time.sleep(processing_time)

            # Update progress
            progress_tracker.update(item, 1)

            # Show progress info
            progress_info = progress_tracker.get_progress_info()
            eta = progress_info["eta_seconds"]
            eta_str = f"{int(eta//60)}m {int(eta%60)}s" if eta > 0 else "unknown"

            print(
                f"Done! [{progress_info['completed']}/{progress_info['total']}] "
                f"({progress_info['progress_pct']:.1f}%) ETA: {eta_str}"
            )

    except KeyboardInterrupt:
        print(
            "\n⚠️  Received KeyboardInterrupt - this shouldn't happen with proper signal handling!"
        )

    finally:
        progress_tracker.cleanup()
        final_progress = progress_tracker.get_progress_info()

        if final_progress["cancelled"]:
            print("\n✅ Test PASSED: Cancellation handled gracefully!")
            print(
                f"   Processed {final_progress['completed']}/{final_progress['total']} items"
            )
            print(f"   Total time: {final_progress['elapsed']:.1f}s")
        else:
            print(
                "\n✅ Test completed normally:"
                f" {final_progress['completed']}/{final_progress['total']} items"
            )
            print(f"   Total time: {final_progress['elapsed']:.1f}s")


if __name__ == "__main__":
    simulate_long_operation()
