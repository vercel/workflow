#!/bin/bash
set -e

# Script to recursively resolve all symlinks in the app directory
# This is needed for CI where Next.js dev mode doesn't work well with symlinks

# Only run in CI
if [ -z "$CI" ]; then
  echo "Error: This script should only be run in CI environments"
  echo "If you need to resolve symlinks locally, run it manually with CI=true"
  exit 1
fi

echo "Resolving symlinked files in workflows directory..."

# Special handling for workflows directory if it's a symlink
if [ -L "workflows" ]; then
  workflows_target=$(readlink "workflows")
  # Resolve relative path
  if [[ "$workflows_target" != /* ]]; then
    workflows_target="$PWD/$workflows_target"
  fi

  echo "Workflows directory is a symlink to: $workflows_target"

  # Remove the workflows symlink
  rm "workflows"

  # Create workflows as a real directory
  mkdir -p "workflows"

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
        cp "$file_target" "workflows/$filename"
      else
        # If it's a regular file, just copy it
        echo "  Copying: $filename"
        cp "$file" "workflows/$filename"
      fi
    done
  fi
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

echo "All symlinks resolved successfully!"
