#!/bin/bash
set -e

# Script to recursively resolve all symlinks in a workbench directory
# This is needed for CI where dev mode doesn't work well with symlinks
#
# Usage: ./scripts/resolve-symlinks.sh <workbench-directory>
# Example: ./scripts/resolve-symlinks.sh workbench/nextjs-turbopack

# Check if directory argument is provided
if [ -z "$1" ]; then
  echo "Error: No directory specified"
  echo "Usage: $0 <workbench-directory>"
  exit 1
fi

TARGET_DIR="$1"

# Check if directory exists
if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

# Only run in CI
if [ -z "$CI" ]; then
  echo "Error: This script should only be run in CI environments"
  echo "If you need to resolve symlinks locally, run it manually with CI=true"
  exit 1
fi

echo "Resolving symlinks in $TARGET_DIR..."
cd "$TARGET_DIR"

# Function to resolve a workflows directory symlink
resolve_workflows_symlink() {
  local workflows_path="$1"

  if [ -L "$workflows_path" ]; then
    workflows_target=$(readlink "$workflows_path")
    # Resolve relative path
    if [[ "$workflows_target" != /* ]]; then
      workflows_target="$(dirname "$workflows_path")/$workflows_target"
    fi
    # Normalize the path
    workflows_target=$(cd "$(dirname "$workflows_target")" && pwd)/$(basename "$workflows_target")

    echo "Workflows directory '$workflows_path' is a symlink to: $workflows_target"

    # Remove the workflows symlink
    rm "$workflows_path"

    # Create workflows as a real directory
    mkdir -p "$workflows_path"

    # Copy all files from the target, resolving any symlinks in the process
    if [ -d "$workflows_target" ]; then
      for file in "$workflows_target"/*; do
        filename=$(basename "$file")
        if [ -L "$file" ]; then
          # If it's a symlink, resolve it
          file_target=$(readlink "$file")
          if [[ "$file_target" != /* ]]; then
            file_target="$(dirname "$file")/$file_target"
          fi
          echo "  Copying and resolving: $filename -> $file_target"
          cp "$file_target" "$workflows_path/$filename"
        else
          # If it's a regular file, just copy it
          echo "  Copying: $filename"
          cp "$file" "$workflows_path/$filename"
        fi
      done
    fi
    return 0
  fi
  return 1
}

echo "Resolving symlinked files in workflows directory..."

# Check for workflows symlink at root level (e.g., express, nitro workbenches)
if resolve_workflows_symlink "workflows"; then
  echo "Resolved root-level workflows symlink"
fi

# Check for workflows symlink in src/ directory (e.g., NestJS workbench)
if resolve_workflows_symlink "src/workflows"; then
  echo "Resolved src/workflows symlink"
fi

echo "Resolving other symlinks..."

# Find all other symlinks (excluding workflows which we already handled)
git ls-files -z --cached --others --exclude-standard | xargs -0 -I {} sh -c 'test -L "{}" && echo "{}"' | while read -r symlink; do
  # Skip workflows directory as we already handled it
  if [ "$symlink" = "workflows" ]; then
    continue
  fi

  # Get the target of the symlink
  target=$(readlink "$symlink")

  # Check if target is absolute or relative
  if [[ "$target" = /* ]]; then
    resolved_target="$target"
  else
    # Resolve relative symlink path
    symlink_dir=$(dirname "$symlink")
    resolved_target="$symlink_dir/$target"
  fi

  echo "Resolving: $symlink -> $resolved_target"

  # Remove the symlink
  rm "$symlink"

  # Copy the target to the symlink location
  if [ -d "$resolved_target" ]; then
    cp -r "$resolved_target" "$symlink"
  else
    cp "$resolved_target" "$symlink"
  fi
done

echo "All symlinks resolved successfully in $TARGET_DIR!"
