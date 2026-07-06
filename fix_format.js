const fs = require('fs');
let code = fs.readFileSync('apps/backend/src/modules/curator/core/llmClient.ts', 'utf8');
code = code.replace(/\$\{summary\.map\(formatSummaryBook\)\.join\(\'\\n\\n\'\)\}/g, '${JSON.stringify(summary)}');
fs.writeFileSync('apps/backend/src/modules/curator/core/llmClient.ts', code);
