# Makefile for AudioShelf Librarian
# Provides convenient commands for development and distribution

.PHONY: help install dev test clean build docker lint format check all

# Default target
help:
	@echo "AudioShelf Librarian - Available Commands:"
	@echo "=========================================="
	@echo "📦 Setup & Installation:"
	@echo "  make install     Install dependencies"
	@echo "  make dev         Install development dependencies"
	@echo ""
	@echo "🚀 Running:"
	@echo "  make web         Start web interface (development mode)"
	@echo "  make web-prod    Start web interface (production mode)"
	@echo "  make cli         Run CLI interface"
	@echo ""
	@echo "🧪 Testing & Quality:"
	@echo "  make test        Run all tests"
	@echo "  make test-cov    Run tests with coverage"
	@echo "  make lint        Run linting checks"
	@echo "  make format      Format code with black/isort"
	@echo "  make check       Run all quality checks"
	@echo ""
	@echo "📦 Distribution:"
	@echo "  make build       Build distribution packages"
	@echo "  make clean       Clean build artifacts"
	@echo "  make docker      Build Docker image"
	@echo "  make docker-run  Run Docker container"
	@echo ""
	@echo "🔧 Utilities:"
	@echo "  make info        Show project information"
	@echo "  make all         Run complete CI pipeline"

# Installation targets
install:
	pip install -r requirements.txt

dev: install
	pip install pytest pytest-asyncio httpx black isort flake8

# Running targets
web:
	python audioshelf-librarian.py web --dev

web-prod:
	python audioshelf-librarian.py web --workers 4

cli:
	python audioshelf-librarian.py cli --help

# Testing targets
test:
	pytest tests/

test-cov:
	pytest --cov=audioshelf_librarian --cov-report=html tests/

# Code quality targets
lint:
	flake8 audioshelf_librarian/
	flake8 *.py --exclude=venv

format:
	black audioshelf_librarian/ *.py
	isort audioshelf_librarian/ *.py

check: lint test
	@echo "✅ All quality checks passed!"

# Build targets
build: clean
	python setup.py sdist bdist_wheel

clean:
	rm -rf build/ dist/ *.egg-info/
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	rm -rf .pytest_cache/ .coverage htmlcov/

# Docker targets
docker:
	docker build -t audioshelf-librarian:latest .

docker-run: docker
	docker run -p 8000:8000 -v $(PWD)/data:/app/data audioshelf-librarian:latest

docker-compose:
	docker-compose up -d

# Utility targets
info:
	python audioshelf-librarian.py info

version:
	python audioshelf-librarian.py version

# Complete CI pipeline
all: clean format lint test build
	@echo "🎉 Complete CI pipeline successful!"

# Development helpers
install-pre-commit:
	pip install pre-commit
	pre-commit install

requirements:
	pip freeze > requirements.txt

tree:
	tree -I '__pycache__|*.pyc|.git|venv|env'

# Release management commands
release-patch:
	@echo "🏷️  Creating patch release..."
	@./scripts/release.sh patch

release-minor:
	@echo "🏷️  Creating minor release..."
	@./scripts/release.sh minor

release-major:
	@echo "🏷️  Creating major release..."
	@./scripts/release.sh major

release-beta:
	@echo "🏷️  Creating beta release..."
	@./scripts/release.sh beta

# GitHub Actions helpers
check-actions:
	@echo "🔍 Validating GitHub Actions workflows..."
	@yamllint .github/workflows/*.yml || echo "Install yamllint: pip install yamllint"

simulate-ci:
	@echo "🧪 Simulating CI pipeline locally..."
	@make format lint test
	@echo "✅ Local CI simulation complete!"
