# 🚀 GitHub CI/CD Setup and Tagging Guide

This guide walks you through setting up GitHub Actions CI/CD pipelines and using semantic versioning with tags for AudioShelf Librarian.

## 📋 Table of Contents
1. [Repository Secrets Setup](#repository-secrets-setup)
2. [GitHub Actions Overview](#github-actions-overview)
3. [Branch Protection Rules](#branch-protection-rules)
4. [Semantic Versioning & Tags](#semantic-versioning--tags)
5. [Release Process](#release-process)
6. [Monitoring & Troubleshooting](#monitoring--troubleshooting)

---

## 🔐 Repository Secrets Setup

Before the CI/CD pipelines can work, you need to configure repository secrets:

### 1. Go to Repository Settings
```
GitHub Repo → Settings → Secrets and variables → Actions
```

### 2. Add Required Secrets

#### Docker Hub (Optional - for container publishing)
- `DOCKER_USERNAME` - Your Docker Hub username
- `DOCKER_PASSWORD` - Docker Hub access token

#### PyPI (Optional - for Python package publishing)
- `PYPI_API_TOKEN` - PyPI API token for publishing packages
- `TEST_PYPI_API_TOKEN` - Test PyPI API token for testing

### 3. How to Get Tokens

#### Docker Hub Token:
```bash
1. Go to https://hub.docker.com/settings/security
2. Click "New Access Token"
3. Name it "GitHub-Actions"
4. Copy the token to DOCKER_PASSWORD secret
```

#### PyPI Token:
```bash
1. Go to https://pypi.org/manage/account/
2. Scroll to API tokens
3. Click "Add API token"
4. Scope: "Entire account" or specific project
5. Copy token to PYPI_API_TOKEN secret
```

---

## ⚙️ GitHub Actions Overview

We've created 3 main workflows:

### 1. **CI/CD Pipeline** (`.github/workflows/ci-cd.yml`)
**Triggers:** Push to main/develop, Pull Requests
**Jobs:**
- ✅ **Multi-OS Testing** (Ubuntu, Windows, macOS)
- ✅ **Multi-Python Testing** (3.9, 3.10, 3.11, 3.12)  
- ✅ **Code Quality** (flake8, black, isort)
- ✅ **Security Scanning** (safety, bandit)
- ✅ **Docker Building** (on main branch)
- ✅ **Package Publishing** (on releases)

### 2. **Code Quality** (`.github/workflows/code-quality.yml`)
**Triggers:** Pull Requests
**Jobs:**
- 🔧 **Auto-formatting** (black, isort)
- 🔍 **Linting** (flake8)
- 📊 **Coverage Reporting** (pytest-cov)
- 📝 **Type Checking** (mypy)

### 3. **Release Automation** (`.github/workflows/release.yml`)
**Triggers:** Git tags (v*)
**Jobs:**
- 📦 **Binary Building** (PyInstaller for all platforms)
- 🐳 **Docker Image** publishing
- 📝 **Release Notes** generation
- 📋 **Asset Uploads** (executables, archives)

---

## 🛡️ Branch Protection Rules

Set up branch protection to ensure code quality:

### 1. Enable Branch Protection
```
Repository → Settings → Branches → Add rule
```

### 2. Recommended Settings for `main` branch:
```yaml
Branch name pattern: main

☑️ Require a pull request before merging
  ☑️ Require approvals: 1
  ☑️ Dismiss stale PR approvals when new commits are pushed
  ☑️ Require review from code owners

☑️ Require status checks to pass before merging
  ☑️ Require branches to be up to date before merging
  Required status checks:
    - test (ubuntu-latest, 3.11)
    - security
    - quality

☑️ Require conversation resolution before merging
☑️ Include administrators
```

---

## 🏷️ Semantic Versioning & Tags

AudioShelf Librarian uses [Semantic Versioning](https://semver.org/):

### Version Format: `MAJOR.MINOR.PATCH`
- **MAJOR** - Incompatible API changes
- **MINOR** - Backwards-compatible functionality
- **PATCH** - Backwards-compatible bug fixes

### Pre-release Identifiers:
- `v1.0.0-alpha.1` - Alpha release
- `v1.0.0-beta.1` - Beta release
- `v1.0.0-rc.1` - Release candidate

### 📋 Tagging Workflow

#### 1. **Prepare for Release**
```bash
# Make sure you're on main and up to date
git checkout main
git pull origin main

# Update version in files
# - audioshelf-librarian.py (__version__ = "1.0.1")
# - setup.py (version="1.0.1")
# - CHANGELOG.md (add new entry)
```

#### 2. **Create and Push Tag**
```bash
# Create annotated tag (recommended)
git tag -a v1.0.1 -m "Release v1.0.1 - Bug fixes and improvements"

# Or create signed tag (if you have GPG set up)
git tag -s v1.0.1 -m "Release v1.0.1 - Bug fixes and improvements"

# Push tag to GitHub
git push origin v1.0.1
```

#### 3. **Alternative: GitHub Web Interface**
```
1. Go to Releases → Create a new release
2. Click "Choose a tag" → Type "v1.0.1" → "Create new tag"
3. Release title: "AudioShelf Librarian v1.0.1"
4. Describe changes (auto-generated from commits)
5. Check "Set as pre-release" if applicable
6. Click "Publish release"
```

### 🔄 Tag Examples

#### Major Release (Breaking Changes):
```bash
git tag -a v2.0.0 -m "Release v2.0.0 - Major API redesign"
git push origin v2.0.0
```

#### Minor Release (New Features):
```bash
git tag -a v1.1.0 -m "Release v1.1.0 - Database undo functionality"
git push origin v1.1.0
```

#### Patch Release (Bug Fixes):
```bash
git tag -a v1.0.1 -m "Release v1.0.1 - Fix directory picker on Windows"
git push origin v1.0.1
```

#### Pre-release:
```bash
git tag -a v1.1.0-beta.1 -m "Release v1.1.0-beta.1 - Database features testing"
git push origin v1.1.0-beta.1
```

---

## 🚀 Release Process

### 1. **Automated Release (Recommended)**

When you push a tag, GitHub Actions automatically:

#### ✅ **Builds & Tests:**
- Runs full test suite on all platforms
- Performs security scanning
- Validates code quality

#### 📦 **Creates Binaries:**
- Windows executable (.exe)
- macOS binary
- Linux binary
- Cross-platform Python package

#### 🐳 **Updates Docker:**
- Builds new Docker image
- Tags with version number
- Updates 'latest' tag
- Pushes to Docker Hub

#### 📝 **Generates Release:**
- Creates GitHub release
- Auto-generates changelog from commits
- Uploads all binary assets
- Publishes to PyPI (if configured)

### 2. **Manual Release Steps**

#### Pre-release Checklist:
```bash
# 1. Update version numbers
vim audioshelf-librarian.py  # Update __version__
vim setup.py                 # Update version

# 2. Update changelog
vim CHANGELOG.md             # Add new section

# 3. Test everything locally
make test
make lint
python audioshelf-librarian.py web --test

# 4. Commit version bump
git add .
git commit -m "Bump version to v1.0.1"
git push origin main
```

#### Create Release:
```bash
# 5. Create and push tag
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1

# 6. Monitor GitHub Actions
# Go to Actions tab and watch the workflows

# 7. Verify release
# Check Releases page for new release
# Test Docker image: docker pull yourusername/audioshelf-librarian:v1.0.1
```

---

## 🎯 Quick Reference Commands

### Most Common Workflows:

#### **Create New Feature Release:**
```bash
# Update version to v1.1.0
vim audioshelf-librarian.py setup.py CHANGELOG.md
git add . && git commit -m "Bump version to v1.1.0"
git push origin main
git tag -a v1.1.0 -m "Release v1.1.0 - New features"
git push origin v1.1.0
```

#### **Create Bug Fix Release:**
```bash
# Update version to v1.0.1  
vim audioshelf-librarian.py setup.py CHANGELOG.md
git add . && git commit -m "Bump version to v1.0.1"
git push origin main
git tag -a v1.0.1 -m "Release v1.0.1 - Bug fixes"
git push origin v1.0.1
```

#### **List and Manage Tags:**
```bash
# List all tags
git tag -l

# List tags with messages
git tag -l -n

# Delete local tag
git tag -d v1.0.1

# Delete remote tag
git push origin --delete v1.0.1

# Get latest tag
git describe --tags --abbrev=0
```

---

**🚀 Your AudioShelf Librarian project now has enterprise-grade CI/CD!**
