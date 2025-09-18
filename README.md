# AudioShelf Librarian

A powerful tool for organizing audiobook libraries according to AudioBookShelf conventions with intelligent parallel processing for optimal performance.

## 🚀 Features

- **Smart Metadata Extraction**: Reads from AudioBookShelf JSON, ID3 tags, and filenames
- **Parallel Processing**: Leverages multiple CPU cores for faster scanning and organization
- **AudioBookShelf Compliance**: Follows official naming conventions and directory structures
- **Safety First**: Dry-run mode, confirmation prompts, and comprehensive error handling
- **Performance Monitoring**: Built-in benchmarking to optimize for your system

## 📦 Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd AudioShelf-Librarian

# Install dependencies
pip install -r requirements.txt
```

## 🏃‍♂️ Quick Start

### Basic Usage

```bash
# Scan a directory (dry-run by default)
python main.py scan /path/to/audiobooks

# Organize audiobooks from inbox to library
python main.py organize --inbox-path /path/to/inbox --library-path /path/to/library

# Validate existing library compliance
python main.py validate --library-path /path/to/library
```

### Performance Optimization

```bash
# Benchmark your system to find optimal settings
python main.py benchmark /path/to/test/audiobooks

# Use specific number of workers
python main.py scan /path/to/audiobooks --max-workers 8

# Disable parallel processing (if benchmarks show it's slower)
python main.py scan /path/to/audiobooks --no-parallel
```

## ⚡ Parallel Processing

AudioShelf Librarian automatically detects your system capabilities and optimizes performance:

### When Parallel Processing Helps
- **Large libraries** (100+ audiobooks)
- **Multiple subdirectories** to scan
- **Systems with 4+ CPU cores**
- **Fast storage** (SSD, NVMe)

### When to Use Sequential Processing
- **Small libraries** (<20 audiobooks)
- **Single large directories**
- **Low-end systems** (2 cores or less)
- **Network storage** with high latency

### Auto-Optimization
The system automatically chooses optimal worker counts based on your CPU:
- **2 cores or less**: Conservative (sequential or minimal parallelization)
- **4 cores**: Modest parallelization (CPU + 2 workers)
- **8+ cores**: Aggressive I/O parallelization (up to 2x CPU cores)

## 📊 Performance Monitoring

Use the built-in benchmark to optimize your specific setup:

```bash
# Run 5 iterations to get reliable timing
python main.py benchmark /path/to/audiobooks --iterations 5 --verbose

# Example output:
# ✓ Parallel processing is 3.2x faster!
# Recommendation: Use parallel processing (--parallel)
```

## 🎯 Command Reference

### `scan` - Analyze directories for organization needs
```bash
python main.py scan [PATH] [OPTIONS]

Options:
  --library-path TEXT     Target library path (default: /audiobooks)
  --parallel/--no-parallel  Use parallel processing (default: True)
  --max-workers INTEGER   Maximum worker threads (auto-detected)
  --dry-run/--execute     Preview vs execute actions (default: True)
  --verbose               Show detailed performance info
```

### `organize` - Process inbox into library
```bash
python main.py organize [OPTIONS]

Options:
  --inbox-path TEXT       Inbox directory (default: /audiobooks/inbox)
  --library-path TEXT     Library directory (default: /audiobooks)
  --parallel/--no-parallel  Use parallel processing (default: True)
  --auto-confirm          Skip confirmation prompts
```

### `validate` - Check library compliance
```bash
python main.py validate [OPTIONS]

Options:
  --library-path TEXT     Library to validate (default: /audiobooks)
  --parallel/--no-parallel  Use parallel processing (default: True)
```

### `benchmark` - Performance testing
```bash
python main.py benchmark [PATH] [OPTIONS]

Options:
  --iterations INTEGER    Number of test runs (default: 3)
  --verbose              Show detailed timing info
```

## 🏗️ Architecture

The application uses intelligent parallel processing:

### Thread-Safe Operations
- **Directory scanning**: Each subdirectory processed independently
- **Metadata extraction**: Multiple audiobooks processed simultaneously  
- **Path generation**: CPU-intensive operations parallelized

### Smart Resource Management
- **Auto-scaling**: Worker count adapts to system capabilities
- **I/O Optimization**: More workers for I/O-bound operations
- **Memory Efficient**: Processes books in batches to avoid memory exhaustion

### Performance Monitoring
- **Real-time metrics**: Track CPU efficiency and wall-clock time
- **Bottleneck detection**: Identify whether operations are CPU or I/O bound
- **Optimization recommendations**: Automatic tuning suggestions

## 🔧 Configuration

The application automatically configures optimal settings, but you can override:

```python
# In your config
max_workers = 8                    # Manual worker count
parallel_threshold = 10            # Minimum books to enable parallelization
prefer_parallel_scanning = True    # Enable by default
```

## 📈 Performance Tips

1. **Use SSDs**: Parallel I/O benefits greatly from fast storage
2. **Benchmark first**: Run the benchmark command on your typical workload
3. **Monitor resources**: Watch CPU and memory usage during large operations
4. **Tune worker count**: More isn't always better - find your sweet spot
5. **Network storage**: Consider sequential processing for slow network drives

## 🛠️ Development

```bash
# Run tests
python -m pytest tests/

# Check performance
python main.py benchmark /path/to/test/data --verbose

# Development mode with detailed logging
python main.py scan /path --verbose
```

## 🤝 Contributing

The codebase is designed for easy extension:
- **Parallel processing**: Add new parallel operations in `parallel.py`
- **Metadata sources**: Extend `scanner.py` for new formats
- **Organization rules**: Modify `organizer.py` for custom conventions

---

**Pro Tip**: Use `python main.py benchmark` on your actual audiobook library to find the optimal settings for your specific hardware and storage setup!
