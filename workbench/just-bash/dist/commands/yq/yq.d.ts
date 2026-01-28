/**
 * yq - Command-line YAML/XML/INI/CSV/TOML processor
 *
 * Uses jq-style query expressions to process YAML, XML, INI, CSV, and TOML files.
 * Shares the query engine with jq for consistent filtering behavior.
 *
 * Inspired by mikefarah/yq (https://github.com/mikefarah/yq)
 * This is a reimplementation for the just-bash sandboxed environment.
 */
import type { Command } from "../../types.js";
export declare const yqCommand: Command;
