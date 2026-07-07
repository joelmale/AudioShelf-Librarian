const fs = require('fs');
let code = fs.readFileSync('apps/frontend/src/features/curator/pages/Collections.tsx', 'utf8');

// 1. Remove discover mutation and button from GenerateModal
code = code.replace(/  const discover = useMutation\(\{\n    mutationFn: \(\) => api\.discover\(\),\n    onSuccess: \(r\) => \{\n      invalidate\(\['collections'\]\);\n      setOpId\(r\.operationId\);\n    \},\n    onError: \(e: Error\) => toast\(e\.message, 'error'\),\n  \}\);\n\n/, '');

code = code.replace(/          <div style={{ flex: 1 }} \/>\n          \n          <button\n            className="glass-btn"\n            style={{ \n              background: 'linear-gradient\\(135deg, rgba\\(109, 182, 184, 0\\.2\\), rgba\\(138, 180, 248, 0\\.2\\)\\)',\n              border: '1px solid var\\(--accent\\)',\n              color: 'var\\(--text\\)'\n            }}\n            disabled={generate\\.isPending \\|\\| discover\\.isPending \\|\\| \\(Boolean\\(opId\\) && !customDone\\)}\n            onClick={\\(\\) => discover\\.mutate\\(\\)}\n          >\n            {discover\\.isPending \\? 'Discovering\\.\\.\\.' : '✨ Auto-Discover Patterns \\(Local AI\\)'}\n          <\/button>\n          \n/, '');

code = code.replace(/disabled={selected\.size === 0 \|\| generate\.isPending \|\| discover\.isPending \|\| \(Boolean\(opId\) && !customDone\)}/g, 'disabled={selected.size === 0 || generate.isPending || (Boolean(opId) && !customDone)}');

// 2. Add discover mutation and button to Collections
const discoverMutation = `
  const [opId, setOpId] = useState<string | null>(null);
  const op = useOperation(opId);

  const discover = useMutation({
    mutationFn: () => api.discover(),
    onSuccess: (r) => {
      invalidate(['collections']);
      setOpId(r.operationId);
      toast('AI Auto-Discovery started...', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const customDone = op.data && ['completed', 'cancelled', 'error'].includes(op.data.status);
  useEffect(() => {
    if (op.data?.status === 'completed') invalidate(['collections']);
  }, [op.data?.status]);

`;

code = code.replace(/  const pushAll = useMutation\(\{/g, discoverMutation + '  const pushAll = useMutation({');

const discoverButton = `
        <button
          className="glass-btn"
          style={{ 
            background: 'linear-gradient(135deg, rgba(109, 182, 184, 0.2), rgba(138, 180, 248, 0.2))',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            marginRight: '12px'
          }}
          disabled={discover.isPending || (Boolean(opId) && !customDone)}
          onClick={() => discover.mutate()}
        >
          {discover.isPending ? 'Discovering...' : '✨ Auto-Discover Patterns (Local AI)'}
        </button>
        <button className="btn" onClick={() => setModal(true)}>
`;

code = code.replace(/        <button className="btn" onClick={\(\) => setModal\(true\)}>/g, discoverButton);

// Add processing text
const processingText = `
      {op.data && op.data.status !== 'completed' && (
        <div className="muted" style={{ marginBottom: 16 }}>
          AI Auto-Discovery Processing: <span className={\`badge \${op.data.status}\`}>{op.data.status}</span>
          {op.data.error && \` — \${op.data.error.message}\`}
        </div>
      )}

      <div className="row" style={{ margin: '16px 0' }}>
`;

code = code.replace(/      <div className="row" style={{ margin: '16px 0' }}>/, processingText);


fs.writeFileSync('apps/frontend/src/features/curator/pages/Collections.tsx', code);
