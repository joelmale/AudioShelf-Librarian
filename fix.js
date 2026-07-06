const fs = require('fs');
let code = fs.readFileSync('apps/backend/src/modules/curator/core/llmClient.ts', 'utf8');
code = code.replace(/    import {\n  collectionProposalSchema,/g, '      collectionProposalSchema,');
fs.writeFileSync('apps/backend/src/modules/curator/core/llmClient.ts', code);
