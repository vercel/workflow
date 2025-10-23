#!/usr/bin/env node

import { execute } from '@oclif/core';

await execute({ type: 'esm', development: false, dir: import.meta.url });
