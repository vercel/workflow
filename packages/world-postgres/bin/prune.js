#!/usr/bin/env node
import { main } from '../dist/kubernetes/prune/cli.js';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
