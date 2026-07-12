import React, { useEffect, useState } from "react";
import type { ScanOrder } from "@audioshelf/shared";

export const ScannerControl: React.FC = () => {
  const [targetDir, setTargetDir] = useState("");
  const [scanOrder, setScanOrder] = useState<ScanOrder | "alphabetical">("alphabetical");
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs,setJobs]=useState<Array<{id:string;state:string;createdAt:number;items:unknown[]}>>([]);
  const loadJobs=()=>fetch('/api/librarian/jobs').then(r=>r.ok?r.json():Promise.reject()).then(r=>setJobs(r.data??[])).catch(()=>undefined);
  useEffect(()=>{void loadJobs();const timer=setInterval(loadJobs,5000);return()=>clearInterval(timer);},[]);

  const startScan = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/librarian/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ targetDir, scanOrder })
      });
      
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to start scan");
      } else void loadJobs();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="glass-panel">
      <h3 style={{ marginTop: 0, marginBottom: '20px' }}>Start New Scan</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Target Directory (Leave blank for default Inbox)
          </label>
          <input
            type="text"
            className="glass-input"
            placeholder="/path/to/inbox"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
          />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Scan Strategy
          </label>
          <select 
            className="glass-input" 
            value={scanOrder} 
            onChange={(e) => setScanOrder(e.target.value as ScanOrder)}
            style={{ appearance: 'none' }}
          >
            <option value="alphabetical">Alphabetical</option>
            <option value="reverse">Reverse Alphabetical</option>
            <option value="quarters">Quarters Chunking</option>
            <option value="size-desc">Largest First</option>
            <option value="recent">Recently Modified</option>
          </select>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--secondary-accent)', marginBottom: '16px', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      <button 
        className="glass-button" 
        onClick={startScan} 
        disabled={isScanning}
        style={{ width: '100%' }}
      >
        {isScanning ? 'Starting...' : 'Trigger Scan'}
      </button>
      {jobs.length>0&&<div style={{marginTop:'20px'}}><h4>Recent ingest jobs</h4>{jobs.slice(0,5).map(job=><div key={job.id} style={{display:'flex',justifyContent:'space-between',fontSize:'.85rem',padding:'6px 0'}}><span>{new Date(job.createdAt).toLocaleString()} · {job.items.length} item(s)</span><strong>{job.state}</strong></div>)}</div>}
    </div>
  );
};
