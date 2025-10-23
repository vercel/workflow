#!/usr/bin/env bash

set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    echo "Installing Rust"
    curl https://sh.rustup.rs -sSf | sh -s --  -y --profile minimal
    . "$HOME/.cargo/env"
  else
    echo "Rust is required but not installed."
    echo "Please visit https://rustup.rs and follow the installation instructions."
    echo "After installing, run 'rustup target add wasm32-unknown-unknown'"
    exit 1
  fi
fi

# Check if wasm32-unknown-unknown target exists when running locally
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
  if [ -n "${CI:-}" ]; then
    rustup target add wasm32-unknown-unknown
  else
    echo "The wasm32-unknown-unknown target is not installed."
    echo "Please run 'rustup target add wasm32-unknown-unknown' to install it."
    exit 1
  fi
fi

cargo build-wasm32 --release -p swc_plugin_workflow
cp ../../target/wasm32-unknown-unknown/release/swc_plugin_workflow.wasm .
