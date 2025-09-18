# Contributing to AudioShelf Librarian

Thank you for considering contributing to AudioShelf Librarian! This document provides guidelines and information for contributors.

## 🎯 Ways to Contribute

### 🐛 Bug Reports
- Use the GitHub issue tracker
- Include detailed reproduction steps
- Provide system information (OS, Python version, etc.)
- Include relevant log output

### 💡 Feature Requests
- Check existing issues first
- Describe the use case clearly
- Explain how it would improve the user experience
- Consider implementation complexity

### 📝 Code Contributions
- Fork the repository
- Create a feature branch
- Write comprehensive tests
- Follow coding standards
- Update documentation

### 📚 Documentation
- Improve README clarity
- Add usage examples
- Update API documentation
- Fix typos and grammar

## 🔧 Development Setup

### Prerequisites
- Python 3.9 or higher
- Git
- Node.js (for frontend development, if needed)

### Local Development
```bash
# Clone your fork
git clone https://github.com/yourusername/AudioShelf-Librarian.git
cd AudioShelf-Librarian

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Install development dependencies
pip install pytest pytest-asyncio httpx black isort flake8

# Run tests
pytest tests/

# Start development server
python audioshelf-librarian.py web --dev
```

## 📋 Coding Standards

### Python Style
- Follow PEP 8
- Use type hints where possible
- Write comprehensive docstrings
- Maximum line length: 88 characters (Black default)

### Code Formatting
```bash
# Format code
black audioshelf_librarian/
isort audioshelf_librarian/

# Lint code
flake8 audioshelf_librarian/
```

### Naming Conventions
- **Functions**: `snake_case`
- **Classes**: `PascalCase`
- **Variables**: `snake_case`
- **Constants**: `UPPER_SNAKE_CASE`
- **Files**: `snake_case.py`

## 🧪 Testing

### Test Structure
```
tests/
├── test_models.py          # Data model tests
├── test_scanner.py         # Metadata scanning tests
├── test_organizer.py       # Organization logic tests
├── test_web_api.py         # Web API tests
└── test_cli.py             # CLI interface tests
```

### Writing Tests
- Use pytest fixtures for common setup
- Test both success and error cases
- Mock external dependencies
- Aim for >90% code coverage

### Running Tests
```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=audioshelf_librarian

# Run specific test file
pytest tests/test_scanner.py

# Run with verbose output
pytest -v
```

## 🏗️ Architecture Guidelines

### Core Principles
- **Separation of Concerns** - CLI, Web, and Core logic are separate
- **Testability** - All components should be easily testable
- **Error Handling** - Graceful error recovery throughout
- **Performance** - Efficient processing of large libraries
- **Cross-Platform** - Works on Windows, macOS, and Linux

### Module Organization
```
audioshelf_librarian/
├── models.py           # Data structures and Pydantic models
├── scanner.py          # Metadata extraction logic
├── organizer.py        # Organization and path generation
├── parallel.py         # Parallel processing utilities
├── scan_strategies.py  # Scanning order strategies
└── web_app.py          # FastAPI web application
```

### API Design
- Use Pydantic models for data validation
- Provide comprehensive error messages
- Support both sync and async operations
- Include progress callbacks where appropriate

## 🚀 Pull Request Process

### Before Submitting
1. **Fork** the repository
2. **Create** a feature branch from `main`
3. **Implement** your changes
4. **Write or update** tests
5. **Update** documentation
6. **Format** code with Black and isort
7. **Run** the full test suite
8. **Commit** with clear messages

### PR Guidelines
- **Title**: Clear, concise description
- **Description**: Explain what and why
- **Link Issues**: Reference related issues
- **Screenshots**: For UI changes
- **Breaking Changes**: Highlight any breaking changes

### Review Process
1. Automated tests must pass
2. Code review by maintainers
3. Address feedback promptly
4. Squash commits before merge

## 📚 Documentation

### Code Documentation
- Use comprehensive docstrings
- Include parameter and return type information
- Provide usage examples
- Document exceptions that can be raised

### Example Docstring
```python
async def scan_directory_for_books(
    directory: Path,
    config: Configuration
) -> List[Book]:
    """
    Scan a directory for audiobooks and extract metadata.
    
    Args:
        directory: Path to scan for audiobooks
        config: Configuration object with scanning preferences
    
    Returns:
        List of Book objects with extracted metadata
    
    Raises:
        PermissionError: If directory cannot be accessed
        ValueError: If directory does not exist
    
    Example:
        >>> config = Configuration()
        >>> books = await scan_directory_for_books(Path("/audiobooks"), config)
        >>> print(f"Found {len(books)} books")
    """
```

## 🔍 Code Review Guidelines

### For Reviewers
- Be constructive and respectful
- Focus on code quality and maintainability
- Test the changes locally when possible
- Provide specific, actionable feedback

### For Contributors
- Respond to feedback promptly
- Ask questions if feedback is unclear
- Make requested changes in separate commits
- Update tests and documentation as needed

## 🎉 Recognition

Contributors are recognized in several ways:
- Listed in the README contributors section
- Mentioned in release notes
- GitHub contributor statistics
- Special recognition for significant contributions

## 📧 Questions?

If you have questions about contributing:
- Open an issue for general questions
- Join discussions in existing issues
- Check the README for common questions

Thank you for helping make AudioShelf Librarian better! 🎧
