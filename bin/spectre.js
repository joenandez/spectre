#!/usr/bin/env node
import { main } from '../src/main.js';

main(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json') && error?.code) {
    const payload = { ok: false, code: error.code, message };
    for (const field of ['status', 'expectedRevision', 'currentRevision']) {
      if (error[field] !== undefined) payload[field] = error[field];
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
