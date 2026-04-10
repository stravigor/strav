#!/bin/bash

# Sync all package versions to next minor version with overflow logic
# Usage: ./scripts/sync-minor-versions.sh [--dry-run]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
fi

# Get workspace root
WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# List of all packages in dependency order
PACKAGES=(
    kernel
    http database view queue
    signal cli
    workflow brain machine flag auth stripe devtools mcp
    oauth2 search social testing rag faker spring
)

echo -e "${BLUE}🔍 Getting current version from kernel package...${NC}"

# Get current version from kernel package (reference)
CURRENT_VERSION=$(node -p "require('./packages/kernel/package.json').version")
echo "Current version: $CURRENT_VERSION"

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate next minor version with overflow logic
if [[ $MINOR -eq 99 ]]; then
    # Minor overflow: increment major
    NEW_MAJOR=$((MAJOR + 1))
    NEW_VERSION="${NEW_MAJOR}.0.0"
    echo -e "${YELLOW}Minor overflow detected (99 → 0), bumping major version${NC}"
    VERSION_TYPE="major"
else
    # Normal minor increment
    NEW_MINOR=$((MINOR + 1))
    NEW_VERSION="${MAJOR}.${NEW_MINOR}.0"
    VERSION_TYPE="minor"
fi

echo -e "${GREEN}New version: $NEW_VERSION${NC}"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}Would update all packages to version $NEW_VERSION${NC}"
    exit 0
fi

# Update all package.json files
echo -e "\n${BLUE}📝 Updating package versions to $NEW_VERSION...${NC}"
for package in "${PACKAGES[@]}"; do
    pkg_file="packages/$package/package.json"
    if [[ -f "$pkg_file" ]]; then
        echo "  Updating $package..."
        sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/g" "$pkg_file"
    fi
done

# Determine commit message based on version type
case "$VERSION_TYPE" in
    major)
        COMMIT_MSG="chore: bump to major version $NEW_VERSION (minor overflow)

BREAKING CHANGE: Major version bump due to minor version overflow"
        ;;
    minor)
        COMMIT_MSG="feat: bump to minor version $NEW_VERSION

New features and enhancements"
        ;;
esac

# Function to retry git push up to 3 times
git_push_with_retry() {
    local retries=0
    local max_retries=3

    while [[ $retries -lt $max_retries ]]; do
        if git push 2>&1; then
            return 0
        else
            retries=$((retries + 1))
            if [[ $retries -lt $max_retries ]]; then
                echo -e "${YELLOW}    Push failed, retrying ($retries/$max_retries)...${NC}"
                sleep 2
            fi
        fi
    done

    echo -e "${RED}    Failed to push after $max_retries attempts${NC}"
    return 1
}

# Commit and push each package
echo -e "\n${BLUE}💾 Committing and pushing packages...${NC}"

FAILED_PACKAGES=()

for package in "${PACKAGES[@]}"; do
    echo -e "  ${BLUE}Processing $package...${NC}"
    cd "$WORKSPACE_ROOT/packages/$package"

    # Check if there are changes
    if ! git diff --quiet package.json; then
        git add package.json

        git commit -m "$COMMIT_MSG

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>" > /dev/null 2>&1

        if git_push_with_retry; then
            echo -e "    ${GREEN}✓ Pushed $package${NC}"
        else
            echo -e "    ${RED}✗ Failed to push $package${NC}"
            FAILED_PACKAGES+=("$package")
        fi
    else
        echo -e "    ${YELLOW}No changes in $package${NC}"
    fi
done

cd "$WORKSPACE_ROOT"

# Retry failed packages
if [[ ${#FAILED_PACKAGES[@]} -gt 0 ]]; then
    echo -e "\n${YELLOW}🔄 Retrying failed packages...${NC}"
    for package in "${FAILED_PACKAGES[@]}"; do
        echo -e "  Retrying $package..."
        cd "$WORKSPACE_ROOT/packages/$package"
        if git_push_with_retry; then
            echo -e "    ${GREEN}✓ Successfully pushed $package${NC}"
        else
            echo -e "    ${RED}✗ Still failed to push $package${NC}"
        fi
    done
    cd "$WORKSPACE_ROOT"
fi

# Update workspace submodule pointers
echo -e "\n${BLUE}🔗 Updating workspace submodule pointers...${NC}"
git add packages/

# Create commit message based on version type
case "$VERSION_TYPE" in
    major)
        WORKSPACE_MSG="chore: update package submodules to v$NEW_VERSION

BREAKING CHANGE: Major version bump due to minor overflow
Updated all package submodules to version $NEW_VERSION."
        ;;
    minor)
        WORKSPACE_MSG="feat: update package submodules to v$NEW_VERSION

Minor version release with new features.
Updated all package submodules to version $NEW_VERSION."
        ;;
esac

git commit -m "$WORKSPACE_MSG

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>" > /dev/null 2>&1

if git_push_with_retry; then
    echo -e "${GREEN}✓ Pushed workspace changes${NC}"
else
    echo -e "${RED}✗ Failed to push workspace changes${NC}"
    echo -e "${YELLOW}Please run 'git push' manually to complete${NC}"
fi

echo -e "\n${GREEN}🎉 All packages successfully bumped to v$NEW_VERSION!${NC}"