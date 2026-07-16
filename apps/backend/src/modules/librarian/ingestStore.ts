import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { OrganizationAction } from '@audioshelf/shared';

export type IngestState = 'discovered'|'approved'|'staging'|'finalized'|'scan_requested'|'abs_item_resolved'|'enriched'|'complete'|'failed'|'cancelled';
export interface IngestJobItem { id:string; jobId:string; state:IngestState; action:OrganizationAction; attempts:number; error:string|null; absItemId:string|null; updatedAt:number }
export interface IngestJob { id:string; state:IngestState; targetDir:string; libraryId:string|null; planOnly:boolean; createdAt:number; updatedAt:number; items:IngestJobItem[] }

export class IngestStore {
  private db: Database.Database;
  constructor(dbPath = process.env.DB_PATH ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(),'data'), 'curator.db')) {
    this.db = new Database(dbPath); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ingest_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,target_dir TEXT NOT NULL,library_id TEXT,plan_only INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_job_items(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,state TEXT NOT NULL,action_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,abs_item_id TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_ingest_items_job ON ingest_job_items(job_id);`);
    const jobColumns = this.db.prepare('PRAGMA table_info(ingest_jobs)').all() as Array<{name:string}>;
    if (!jobColumns.some((column) => column.name === 'plan_only')) this.db.exec('ALTER TABLE ingest_jobs ADD COLUMN plan_only INTEGER NOT NULL DEFAULT 0');
    this.db.prepare("UPDATE ingest_jobs SET state='failed',updated_at=? WHERE state IN ('staging','finalized','scan_requested','abs_item_resolved','enriched')").run(Date.now());
    this.db.prepare("UPDATE ingest_job_items SET state='failed',error=COALESCE(error,'Interrupted by restart'),updated_at=? WHERE state IN ('staging','finalized','scan_requested','abs_item_resolved','enriched')").run(Date.now());
  }
  create(targetDir:string, libraryId?:string, planOnly=false): string { const id=randomUUID(), now=Date.now(); this.db.prepare('INSERT INTO ingest_jobs(id,state,target_dir,library_id,plan_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'discovered',targetDir,libraryId??null,planOnly?1:0,now,now); return id; }
  addItem(jobId:string, action:OrganizationAction): string { const id=randomUUID(); this.db.prepare('INSERT INTO ingest_job_items VALUES(?,?,?,?,0,NULL,NULL,?)').run(id,jobId,'discovered',JSON.stringify(action),Date.now()); this.touch(jobId); return id; }
  transitionItem(id:string,state:IngestState,error?:string|null,absItemId?:string|null):void { const row=this.db.prepare('SELECT job_id FROM ingest_job_items WHERE id=?').get(id) as {job_id:string}|undefined; if(!row) throw new Error('Ingest item not found'); this.db.prepare('UPDATE ingest_job_items SET state=?,error=?,abs_item_id=COALESCE(?,abs_item_id),attempts=attempts+1,updated_at=? WHERE id=?').run(state,error??null,absItemId??null,Date.now(),id); this.recompute(row.job_id); }
  cancelJob(id:string):void { this.db.prepare("UPDATE ingest_job_items SET state='cancelled',updated_at=? WHERE job_id=? AND state NOT IN ('complete','cancelled')").run(Date.now(),id); this.db.prepare("UPDATE ingest_jobs SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(),id); }
  get(id:string):IngestJob|undefined { const job=this.db.prepare('SELECT * FROM ingest_jobs WHERE id=?').get(id) as any; return job?this.map(job):undefined; }
  list():IngestJob[] { return (this.db.prepare('SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 100').all() as any[]).map(r=>this.map(r)); }
  hasActiveJobForTarget(targetDir: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM ingest_jobs WHERE target_dir=? AND state NOT IN ('complete', 'cancelled')").get(targetDir);
    return !!row;
  }
  close():void { this.db.close(); }
  private map(r:any):IngestJob { const items=(this.db.prepare('SELECT * FROM ingest_job_items WHERE job_id=? ORDER BY updated_at').all(r.id) as any[]).map(i=>({id:i.id,jobId:i.job_id,state:i.state,action:JSON.parse(i.action_json),attempts:i.attempts,error:i.error,absItemId:i.abs_item_id,updatedAt:i.updated_at})); return {id:r.id,state:r.state,targetDir:r.target_dir,libraryId:r.library_id,planOnly:r.plan_only===1,createdAt:r.created_at,updatedAt:r.updated_at,items}; }
  private touch(id:string):void { this.db.prepare('UPDATE ingest_jobs SET updated_at=? WHERE id=?').run(Date.now(),id); }
  private recompute(id:string):void { const states=(this.db.prepare('SELECT state FROM ingest_job_items WHERE job_id=?').all(id) as any[]).map(r=>r.state as IngestState); const state:IngestState=states.some(s=>s==='failed')?'failed':states.length&&states.every(s=>s==='complete')?'complete':states.some(s=>s==='staging')?'staging':'discovered'; this.db.prepare('UPDATE ingest_jobs SET state=?,updated_at=? WHERE id=?').run(state,Date.now(),id); }
}
