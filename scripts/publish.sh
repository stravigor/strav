#!/bin/bash

# Enhanced publish script for Stravigor packages
# Properly replaces workspace:* with actual versions before publishing

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse arguments
DRY_RUN=false
SKIP_CHECK=false
SPECIFIC_PACKAGES=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --skip-check)
            SKIP_CHECK=true
            shift
            ;;
        --package)
            SPECIFIC_PACKAGES="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dry-run       Test without actually publishing"
            echo "  --skip-check    Skip npm login check"
            echo "  --package PKG   Publish specific package(s) (comma-separated)"
            echo "  --help          Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                              # Publish all packages"
            echo "  $0 --dry-run                    # Test without publishing"
            echo "  $0 --package kernel              # Publish only kernel"
            echo "  $0 --package kernel,database    # Publish kernel and database"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Run '$0 --help' for usage information"
            exit 1
            ;;
    esac
done

# Get workspace root
WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# All packages in dependency order
ALL_PACKAGES=(
    # Core (tier 1)
    kernel
    # Tier 2 - depend on kernel
    http database view queue workflow
    # Tier 3 - depend on multiple core packages
    signal cli
    # Consumer packages
    auth machine
    brain flag stripe devtools mcp
    oauth2 search social testing rag faker
    # Flagship framework scaffolding
    spring
)

# Determine which packages to publish
if [[ -n "$SPECIFIC_PACKAGES" ]]; then
    # Convert comma-separated string to array
    IFS=',' read -ra PACKAGES <<< "$SPECIFIC_PACKAGES"
    echo -e "${CYAN}🎯 Publishing specific packages: ${PACKAGES[*]}${NC}"
else
    PACKAGES=("${ALL_PACKAGES[@]}")
    echo -e "${CYAN}📚 Publishing all packages${NC}"
fi

echo -e "${BLUE}🚀 Starting Stravigor package publishing...${NC}"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}DRY RUN MODE - No packages will be published${NC}"
fi

# Check if logged into npm (unless skipped)
if [[ "$SKIP_CHECK" == false ]]; then
    echo -e "${BLUE}🔐 Checking npm authentication...${NC}"
    if ! npm whoami &>/dev/null; then
        echo -e "${RED}❌ You need to be logged into npm. Run: npm login${NC}"
        exit 1
    else
        NPM_USER=$(npm whoami)
        echo -e "${GREEN}✓ Logged in as: $NPM_USER${NC}"
    fi
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq is not installed. Installing with brew...${NC}"
    if command -v brew &> /dev/null; then
        brew install jq
    else
        echo -e "${YELLOW}⚠️  Cannot install jq automatically. Using sed fallback (less reliable).${NC}"
    fi
fi

# Function to get current version from package.json
get_version() {
    local pkg_dir=$1
    grep '"version"' "$pkg_dir/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/'
}

# Function to check if package is private
is_private() {
    local pkg_dir=$1
    grep -q '"private":\s*true' "$pkg_dir/package.json"
}

# Function to replace workspace:* with actual versions
fix_workspace_deps() {
    local pkg_file=$1
    local version=$2

    # Create a temporary file
    local tmp_file="${pkg_file}.tmp"

    # Use jq to replace workspace:* with actual version in dependencies and peerDependencies
    if command -v jq &> /dev/null; then
        jq --arg v "$version" '
            if .dependencies then
                .dependencies |= with_entries(
                    if .value == "workspace:*" and (.key | startswith("@strav/"))
                    then .value = $v
                    else .
                    end
                )
            else . end |
            if .peerDependencies then
                .peerDependencies |= with_entries(
                    if .value == "workspace:*" and (.key | startswith("@strav/"))
                    then .value = $v
                    else .
                    end
                )
            else . end |
            if .devDependencies then
                .devDependencies |= with_entries(
                    if .value == "workspace:*" and (.key | startswith("@strav/"))
                    then .value = $v
                    else .
                    end
                )
            else . end
        ' "$pkg_file" > "$tmp_file"

        mv "$tmp_file" "$pkg_file"
    else
        # Fallback to sed if jq is not available
        sed -i.bak "s/\"workspace:\*\"/\"$version\"/g" "$pkg_file"
        rm "${pkg_file}.bak"
    fi
}

# Function to check if version is already published
is_published() {
    local pkg_name=$1
    local version=$2

    npm view "@strav/$pkg_name@$version" version &>/dev/null
}

# Function to publish a package with workspace fix
publish_package() {
    local pkg_name=$1
    local pkg_dir="packages/$pkg_name"

    # Check if package directory exists
    if [[ ! -d "$pkg_dir" ]]; then
        echo -e "  ${YELLOW}⚠️  Package $pkg_name does not exist${NC}"
        return 1
    fi

    cd "$pkg_dir" || return 1

    # Check if package is private
    if is_private "."; then
        echo -e "  ${YELLOW}⏭️  Skipping $pkg_name (private package)${NC}"
        cd "$WORKSPACE_ROOT"
        return 0
    fi

    # Get the current version
    local version=$(get_version ".")

    # Check if already published
    if is_published "$pkg_name" "$version"; then
        echo -e "  ${CYAN}✓ @strav/$pkg_name@$version already published${NC}"
        cd "$WORKSPACE_ROOT"
        return 0
    fi

    echo -e "  ${BLUE}📦 Publishing @strav/$pkg_name@$version...${NC}"

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "    ${YELLOW}[DRY RUN] Would publish @strav/$pkg_name@$version${NC}"
        cd "$WORKSPACE_ROOT"
        return 0
    fi

    # Backup original package.json
    cp package.json package.json.original

    # Fix workspace dependencies
    echo -e "    Fixing workspace dependencies..."
    fix_workspace_deps "package.json" "$version"

    # Publish with bun
    if bun publish --access public 2>&1 | grep -v "npm notice"; then
        echo -e "  ${GREEN}✅ Successfully published @strav/$pkg_name@$version${NC}"
        PUBLISHED_PACKAGES+=("$pkg_name@$version")
    else
        echo -e "  ${RED}❌ Failed to publish @strav/$pkg_name${NC}"
        FAILED_PACKAGES+=("$pkg_name")
    fi

    # Restore original package.json
    mv package.json.original package.json

    cd "$WORKSPACE_ROOT"
}

# Arrays to track results
PUBLISHED_PACKAGES=()
FAILED_PACKAGES=()
SKIPPED_PACKAGES=()

# Publish packages
echo -e "\n${BLUE}📚 Publishing packages...${NC}"

for package in "${PACKAGES[@]}"; do
    publish_package "$package"
done

# Summary
echo -e "\n${BLUE}📊 Publishing Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ ${#PUBLISHED_PACKAGES[@]} -gt 0 ]]; then
    echo -e "${GREEN}✅ Published (${#PUBLISHED_PACKAGES[@]})${NC}"
    for pkg in "${PUBLISHED_PACKAGES[@]}"; do
        echo -e "   • @strav/$pkg"
    done
fi

if [[ ${#FAILED_PACKAGES[@]} -gt 0 ]]; then
    echo -e "${RED}❌ Failed (${#FAILED_PACKAGES[@]})${NC}"
    for pkg in "${FAILED_PACKAGES[@]}"; do
        echo -e "   • $pkg"
    done
fi

# Verification commands
if [[ "$DRY_RUN" == false ]] && [[ ${#PUBLISHED_PACKAGES[@]} -gt 0 ]]; then
    echo -e "\n${BLUE}🔍 Verify published packages:${NC}"
    echo -e "${CYAN}npm view @strav/<package> version${NC}"
    echo -e "${CYAN}npm view @strav/<package> peerDependencies${NC}"
fi

if [[ "$DRY_RUN" == true ]]; then
    echo -e "\n${YELLOW}This was a dry run. No packages were published.${NC}"
    echo -e "${YELLOW}Remove --dry-run flag to actually publish.${NC}"
elif [[ ${#PUBLISHED_PACKAGES[@]} -gt 0 ]]; then
    echo -e "\n${GREEN}🎉 Publishing complete!${NC}"
else
    echo -e "\n${YELLOW}⚠️  No packages were published.${NC}"
fi