import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAcceptanceCli } from '../apps/backend/src/modules/curator/core/retrieval/acceptanceCli.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = runAcceptanceCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
