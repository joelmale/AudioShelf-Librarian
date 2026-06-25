#!/usr/bin/env python3
"""
Setup script for AudioShelf Librarian

This script handles installation, configuration, and distribution preparation
for the AudioShelf Librarian project.
"""

from setuptools import setup, find_packages
from pathlib import Path
import re

# Read the project root directory
project_root = Path(__file__).parent

# Read version from main script
def get_version():
    main_file = project_root / "audioshelf-librarian.py"
    if main_file.exists():
        with open(main_file) as f:
            content = f.read()
            version_match = re.search(r'__version__ = ["\']([^"\']*)["\']', content)
            if version_match:
                return version_match.group(1)
    return "1.0.0"

# Read README for long description
def get_long_description():
    readme_path = project_root / "README.md"
    if readme_path.exists():
        with open(readme_path, encoding="utf-8") as f:
            return f.read()
    return "AudioShelf Librarian - Intelligent audiobook library organizer for AudioBookShelf"

# Read requirements
def get_requirements():
    req_path = project_root / "requirements.txt"
    if req_path.exists():
        with open(req_path) as f:
            return [line.strip() for line in f if line.strip() and not line.startswith("#")]
    return []

setup(
    name="audioshelf-librarian",
    version=get_version(),
    author="AudioShelf Librarian Contributors",
    author_email="",
    description="Intelligent audiobook library organizer for AudioBookShelf",
    long_description=get_long_description(),
    long_description_content_type="text/markdown",
    url="https://github.com/yourusername/AudioShelf-Librarian",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: End Users/Desktop",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Multimedia :: Sound/Audio",
        "Topic :: System :: Archiving",
        "Topic :: Utilities",
    ],
    python_requires=">=3.9",
    install_requires=get_requirements(),
    extras_require={
        "dev": [
            "pytest>=7.4.0",
            "pytest-asyncio>=0.21.0",
            "httpx>=0.25.0",
            "black>=23.0.0",
            "isort>=5.12.0",
            "flake8>=6.0.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "audioshelf-librarian=audioshelf-librarian:app",
            "audioshelf-cli=audioshelf-cli:app",
            "audioshelf-server=audioshelf-server:app",
        ],
    },
    include_package_data=True,
    package_data={
        "audioshelf_librarian": ["templates/*", "static/*"],
    },
    zip_safe=False,
)
