import fs from 'node:fs';

import type { AcceptanceSnapshot } from './acceptance.js';
import { parseAcceptanceQueryFile, runAcceptanceHarness } from './acceptance.js';
import { loadReadonlyAcceptanceSnapshot } from './acceptanceSnapshot.js';

export interface AcceptanceCliDeps {
  readFile?: (path: string) => string;
  loadSnapshot?: (path: string, model: string) => AcceptanceSnapshot;
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

export function acceptanceCliUsage(): string {
  return `Usage: npm run acceptance:retrieval -- --snapshot <consistent-snapshot.db> --queries <queries.json>

Reads a user-created SQLite snapshot in strict readonly mode and writes the JSON
report to stdout. The snapshot filename must contain "snapshot". This command
does not embed queries, contact the network, migrate a database, or edit ranker
weights. Populate queryVector values out-of-band for the configured model.

The shipped template intentionally has blank queries/vectors/expectations and
must be copied and completed before use. Configured expectation failures exit 2.`;
}

function parseArgs(args: readonly string[]): { snapshotPath: string; queryPath: string } | 'help' {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return 'help';
  if (args.length !== 4 || args[0] !== '--snapshot' || args[2] !== '--queries' || !args[1] || !args[3]) {
    throw new Error(acceptanceCliUsage());
  }
  return { snapshotPath: args[1], queryPath: args[3] };
}

/** Returns an exit status; 2 means the harness ran but an approved expectation failed. */
export function runAcceptanceCli(args: readonly string[], deps: AcceptanceCliDeps = {}): number {
  const parsedArgs = parseArgs(args);
  const writeOut = deps.writeOut ?? ((text: string) => process.stdout.write(text));
  if (parsedArgs === 'help') {
    writeOut(`${acceptanceCliUsage()}\n`);
    return 0;
  }
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const loadSnapshot = deps.loadSnapshot ?? loadReadonlyAcceptanceSnapshot;
  const queryFile = parseAcceptanceQueryFile(JSON.parse(readFile(parsedArgs.queryPath)) as unknown);
  const report = runAcceptanceHarness(loadSnapshot(parsedArgs.snapshotPath, queryFile.embeddingModel), queryFile);
  writeOut(`${JSON.stringify(report, null, 2)}\n`);
  if (report.expectations.failedRuns > 0) {
    const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));
    writeError(`${report.expectations.failedRuns} configured ranking expectation run(s) failed\n`);
    return 2;
  }
  return 0;
}
