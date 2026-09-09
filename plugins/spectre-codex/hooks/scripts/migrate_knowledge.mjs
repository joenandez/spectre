#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as knowledgeCliMain, parseArgs, writeCliError } from './knowledge-cli.mjs';

const __filename = fileURLToPath(import.meta.url);

/** Legacy executable name only; command behavior lives in the canonical public CLI. */
export async function main(argv = process.argv.slice(2)) {
  return knowledgeCliMain(['migrate', ...argv]);
}

export { parseArgs };

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main().catch((error) => writeCliError(error));
}
