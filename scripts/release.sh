#!/bin/bash
# Release automation script for AudioShelf Librarian
# Usage: ./scripts/release.sh [patch|minor|major|beta]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log_error "This script must be run from within a git repository"
    exit 1
fi

# Check if working directory is clean
if [[ -n $(git status --porcelain) ]]; then
    log_error "Working directory is not clean. Please commit or stash your changes."
    git status --short
    exit 1
fi

# Check if we're on main branch
current_branch=$(git branch --show-current)
if [[ "$current_branch" != "main" ]]; then
    log_warning "You're on branch '$current_branch', not 'main'"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled by user"
        exit 0
    fi
fi

# Get current version from audioshelf-librarian.py
get_current_version() {
    grep "__version__" audioshelf-librarian.py | sed 's/.*"\(.*\)".*/\1/'
}

# Calculate next version
calculate_next_version() {
    local current_version=$1
    local release_type=$2
    
    # Parse version (assuming semantic versioning: MAJOR.MINOR.PATCH)
    IFS='.' read -ra VERSION_PARTS <<< "$current_version"
    local major=${VERSION_PARTS[0]}
    local minor=${VERSION_PARTS[1]}
    local patch=${VERSION_PARTS[2]}
    
    case $release_type in
        "patch")
            patch=$((patch + 1))
            ;;
        "minor")
            minor=$((minor + 1))
            patch=0
            ;;
        "major")
            major=$((major + 1))
            minor=0
            patch=0
            ;;
        "beta")
            # For beta, append -beta.1 or increment existing beta number
            if [[ $current_version == *"-beta"* ]]; then
                # Extract and increment beta number
                beta_num=$(echo $current_version | sed 's/.*-beta\.\([0-9]*\).*/\1/')
                beta_num=$((beta_num + 1))
                echo "${major}.${minor}.${patch}-beta.${beta_num}"
                return
            else
                echo "${major}.${minor}.${patch}-beta.1"
                return
            fi
            ;;
        *)
            log_error "Invalid release type: $release_type"
            exit 1
            ;;
    esac
    
    echo "${major}.${minor}.${patch}"
}

# Update version in files
update_version_files() {
    local new_version=$1
    
    log_info "Updating version to $new_version in project files..."
    
    # Update audioshelf-librarian.py
    sed -i.bak "s/__version__ = \".*\"/__version__ = \"$new_version\"/" audioshelf-librarian.py
    rm audioshelf-librarian.py.bak
    
    # Update setup.py
    sed -i.bak "s/version=\".*\"/version=\"$new_version\"/" setup.py
    rm setup.py.bak
    
    log_success "Updated version files"
}

# Update changelog
update_changelog() {
    local new_version=$1
    local release_type=$2
    
    log_info "Updating CHANGELOG.md..."
    
    # Get commits since last tag
    local last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
    local commits=""
    
    if [[ -n "$last_tag" ]]; then
        commits=$(git log --oneline --pretty=format:"- %s (%h)" $last_tag..HEAD)
    else
        commits=$(git log --oneline --pretty=format:"- %s (%h)" HEAD)
    fi
    
    # Create temporary changelog entry
    local temp_entry="## [$new_version] - $(date +%Y-%m-%d)

### $(echo $release_type | sed 's/.*/\u&/')
$commits

"
    
    # Insert at the top of changelog (after the header)
    if [[ -f "CHANGELOG.md" ]]; then
        # Create temp file with new entry
        echo "$temp_entry" > /tmp/changelog_entry
        # Add existing changelog content
        tail -n +2 CHANGELOG.md >> /tmp/changelog_entry
        # Write back to CHANGELOG.md
        mv /tmp/changelog_entry CHANGELOG.md
    else
        # Create new changelog
        echo "# Changelog" > CHANGELOG.md
        echo "" >> CHANGELOG.md
        echo "$temp_entry" >> CHANGELOG.md
    fi
    
    log_success "Updated CHANGELOG.md"
}

# Main release function
perform_release() {
    local release_type=$1
    
    log_info "Starting $release_type release process..."
    
    # Get current version
    local current_version=$(get_current_version)
    log_info "Current version: $current_version"
    
    # Calculate new version
    local new_version=$(calculate_next_version "$current_version" "$release_type")
    log_info "New version: $new_version"
    
    # Confirm with user
    echo
    log_warning "This will create a $release_type release: $current_version → $new_version"
    read -p "Continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled by user"
        exit 0
    fi
    
    # Pull latest changes
    log_info "Pulling latest changes from origin..."
    git pull origin "$current_branch"
    
    # Run tests
    log_info "Running tests..."
    if command -v make &> /dev/null; then
        make test || {
            log_error "Tests failed! Please fix before releasing."
            exit 1
        }
    else
        python -m pytest tests/ || {
            log_error "Tests failed! Please fix before releasing."
            exit 1
        }
    fi
    
    # Update version files
    update_version_files "$new_version"
    
    # Update changelog
    update_changelog "$new_version" "$release_type"
    
    # Commit version bump
    log_info "Committing version bump..."
    git add audioshelf-librarian.py setup.py CHANGELOG.md
    git commit -m "Bump version to v$new_version"
    
    # Create and push tag
    local tag_name="v$new_version"
    log_info "Creating tag $tag_name..."
    
    if [[ "$release_type" == "beta" ]]; then
        git tag -a "$tag_name" -m "Beta release $tag_name"
    else
        git tag -a "$tag_name" -m "Release $tag_name"
    fi
    
    # Push changes and tag
    log_info "Pushing to origin..."
    git push origin "$current_branch"
    git push origin "$tag_name"
    
    log_success "Release $tag_name created successfully!"
    echo
    log_info "GitHub Actions will now:"
    echo "  ✅ Run full test suite"
    echo "  ✅ Build binaries for all platforms"
    echo "  ✅ Create Docker images"
    echo "  ✅ Publish to PyPI (if configured)"
    echo "  ✅ Create GitHub release with assets"
    echo
    log_info "Monitor progress at: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git.*/\1/')/actions"
}

# Show usage
show_usage() {
    echo "Usage: $0 [patch|minor|major|beta]"
    echo
    echo "Release types:"
    echo "  patch  - Bug fixes (1.0.0 → 1.0.1)"
    echo "  minor  - New features (1.0.0 → 1.1.0)"
    echo "  major  - Breaking changes (1.0.0 → 2.0.0)"
    echo "  beta   - Beta release (1.0.0 → 1.0.0-beta.1)"
    echo
    echo "Examples:"
    echo "  $0 patch     # Create a patch release"
    echo "  $0 minor     # Create a minor release"
    echo "  $0 major     # Create a major release"
    echo "  $0 beta      # Create a beta release"
}

# Main script
if [[ $# -ne 1 ]]; then
    log_error "Invalid number of arguments"
    show_usage
    exit 1
fi

release_type=$1

# Validate release type
if [[ ! "$release_type" =~ ^(patch|minor|major|beta)$ ]]; then
    log_error "Invalid release type: $release_type"
    show_usage
    exit 1
fi

# Check for required tools
required_tools=("git" "sed" "grep")
for tool in "${required_tools[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
        log_error "Required tool '$tool' is not installed"
        exit 1
    fi
done

# Perform the release
perform_release "$release_type"
