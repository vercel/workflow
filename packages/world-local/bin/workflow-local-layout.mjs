#!/usr/bin/env node
// Inspect or convert a @workflow/world-local data directory's layout.
// Run `workflow-local-layout --help` for usage.
import { runLayoutCli } from '../dist/layout-cli.js';

process.exitCode = await runLayoutCli(process.argv.slice(2));
