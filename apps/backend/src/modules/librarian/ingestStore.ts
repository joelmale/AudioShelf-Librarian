import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { OrganizationAction } from '@audioshelf/shared';

export type IngestState = 'discovered'|'approved'|'staging'|'finalized'|'scan_requested'|'abs_item_resolved'|'enriched'|'complete'|'failed'|'cancelled'|'discarded';
export interface IngestJobItem { id:string; jobId:string; state:IngestState; action:OrganizationAction; attempts:number; error:string|null; absItemId:string|null; updatedAt:number }
export interface IngestJob { id:string; state:IngestState; targetDir:string; libraryId:string|null; planOnly:boolean; createdAt:number; updatedAt:number; items:IngestJobItem[] }
interface IngestItemRow { id:string; job_id:string; state:IngestState; action_json:string; attempts:number; error:string|null; abs_item_id:string|null; updated_at:number }
interface IngestJobRow { id:string; state:IngestState; target_dir:string; library_id:string|null; plan_only:number; created_at:number; updated_at:number }

export class IngestStore {
  private db: Database.Database;
  /**
   * `recoverInterrupted` fails items a previous process left mid-transfer. Only
   * the store that owns imports should do it: a second connection opened later
   * (the Activity feed) would otherwise fail transfers that are running right now.
   */
  constructor(dbPath = process.env.DB_PATH ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(),'data'), 'curator.db'), options: { recoverInterrupted?: boolean } = {}) {
    this.db = new Database(dbPath); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON');
    // This is a SECOND connection to the same file CuratorDb opens. Without a
    // busy timeout a concurrent write (the inbox poller, a commit loop, and the
    // encode worker can all be active at once) fails immediately with
    // SQLITE_BUSY instead of waiting for the other writer to finish.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ingest_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,target_dir TEXT NOT NULL,library_id TEXT,plan_only INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_job_items(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,state TEXT NOT NULL,action_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,abs_item_id TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_ingest_items_job ON ingest_job_items(job_id);
      CREATE TABLE IF NOT EXISTS ingest_collections(source TEXT PRIMARY KEY, review_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_collection_generations(source TEXT NOT NULL, identity TEXT NOT NULL, review_json TEXT NOT NULL, PRIMARY KEY(source,identity));
      CREATE TABLE IF NOT EXISTS ingest_collection_archive_parents(item_id TEXT PRIMARY KEY REFERENCES ingest_job_items(id) ON DELETE CASCADE, source TEXT NOT NULL, identity TEXT NOT NULL, primary_parent INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_collection_archive_generation ON ingest_collection_archive_parents(source, identity);
      CREATE TABLE IF NOT EXISTS ingest_collection_queue(item_id TEXT PRIMARY KEY REFERENCES ingest_job_items(id) ON DELETE CASCADE, queued_at INTEGER NOT NULL);`);
    const jobColumns = this.db.prepare('PRAGMA table_info(ingest_jobs)').all() as Array<{name:string}>;
    if (!jobColumns.some((column) => column.name === 'plan_only')) this.db.exec('ALTER TABLE ingest_jobs ADD COLUMN plan_only INTEGER NOT NULL DEFAULT 0');
    if (options.recoverInterrupted === false) return;
    this.db.prepare("UPDATE ingest_jobs SET state='failed',updated_at=? WHERE state IN ('staging','finalized','scan_requested','abs_item_resolved','enriched')").run(Date.now());
    this.db.prepare("UPDATE ingest_job_items SET state='failed',error=COALESCE(error,'Interrupted by restart'),updated_at=? WHERE state IN ('staging','finalized','scan_requested','abs_item_resolved','enriched')").run(Date.now());
  }
  private sourceIdentity(source: string): string | undefined {
    try {
      const stat = statSync(source, { bigint: true, throwIfNoEntry: false });
      return stat?.isDirectory() && stat.ino ? `${stat.dev}:${stat.ino}` : undefined;
    } catch { return undefined; }
  }
  readCollection(source: string): string | undefined {
    const identity = this.sourceIdentity(source);
    const generation = identity && this.db.prepare('SELECT review_json FROM ingest_collection_generations WHERE source=? AND identity=?')
      .get(source, identity) as { review_json: string } | undefined;
    if (generation) return generation.review_json;
    const row = this.db.prepare('SELECT review_json FROM ingest_collections WHERE source=?').get(source) as
      { review_json: string } | undefined;
    return row?.review_json;
  }
  writeCollection(source: string, payload: string): void {
    const identity = this.sourceIdentity(source);
    if (identity && this.db.prepare('UPDATE ingest_collection_generations SET review_json=? WHERE source=? AND identity=?')
      .run(payload, source, identity).changes) return;
    this.db.prepare('INSERT INTO ingest_collections(source,review_json) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET review_json=excluded.review_json')
      .run(source, payload);
  }
  bindArchiveToSource(source: string, itemId: string, holdReason: string): void {
    const identity = this.sourceIdentity(source);
    if (!identity) throw new Error("The collection is no longer in the inbox");
    const otherParents = this.collectionReviewItems(holdReason).filter(item => {
      if (item.id === itemId || !this.isCurrentCollectionParent(item)) return false;
      try { return !path.relative(source, realpathSync(item.action.source_path)); }
      catch { return false; }
    });
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO ingest_collection_generations SELECT source, ?, review_json FROM ingest_collections WHERE source=?')
        .run(identity, source);
      this.db.prepare('DELETE FROM ingest_collections WHERE source=?').run(source);
      const bind = this.db.prepare('INSERT OR REPLACE INTO ingest_collection_archive_parents(item_id,source,identity,primary_parent) VALUES (?,?,?,?)');
      bind.run(itemId, source, identity, 1);
      for (const item of otherParents) bind.run(item.id, source, identity, 0);
    })();
  }
  isCurrentCollectionParent(item: IngestJobItem): boolean {
    const binding = this.db.prepare('SELECT identity, primary_parent FROM ingest_collection_archive_parents WHERE item_id=?').get(item.id) as
      { identity: string; primary_parent: number } | undefined;
    const source = item.action.source_path;
    const identity = this.sourceIdentity(source);
    if (binding) return binding.primary_parent === 1 && binding.identity === identity;
    if (!identity) return true;
    try {
      return !this.db.prepare('SELECT 1 FROM ingest_collection_archive_parents WHERE source=? AND identity=? AND primary_parent=1')
        .get(realpathSync(source), identity);
    } catch { return false; }
  }
  ownsArchivedCollection(source: string, identity: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM ingest_collection_archive_parents WHERE source=? AND identity=? AND primary_parent=1')
      .get(source, identity));
  }
  retireArchivedCollection(source: string, identity: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ingest_collection_generations WHERE source=? AND identity=?').run(source, identity);
      this.db.prepare('UPDATE ingest_collection_archive_parents SET primary_parent=0 WHERE source=? AND identity=?').run(source, identity);
    })();
  }
  enqueueCollection(itemId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO ingest_collection_queue(item_id,queued_at) VALUES (?,?)").run(itemId, Date.now());
  }
  dequeueCollection(itemId: string): void {
    this.db.prepare("DELETE FROM ingest_collection_queue WHERE item_id=?").run(itemId);
  }
  queuedCollectionItems(): string[] {
    return (this.db.prepare("SELECT item_id FROM ingest_collection_queue ORDER BY queued_at,item_id").all() as { item_id: string }[])
      .map(row => row.item_id);
  }
  collectionSources(): string[] {
    const active = new Set((this.db.prepare('SELECT source FROM ingest_collections').all() as { source: string }[]).map(row => row.source));
    const stored = this.db.prepare('SELECT source, identity FROM ingest_collection_generations').all() as { source: string; identity: string }[];
    for (const { source, identity } of stored) if (identity === this.sourceIdentity(source)) active.add(source);
    return [...active];
  }
  latestInboxItems(paths: string[]): IngestJobItem[] {
    const rows = this.db.prepare(`SELECT i.* FROM ingest_job_items i
      JOIN ingest_jobs j ON j.id=i.job_id
      WHERE j.plan_only=0 AND json_extract(i.action_json,'$.source_path') IN (SELECT value FROM json_each(?))
      ORDER BY i.updated_at DESC, j.created_at DESC`).all(JSON.stringify(paths)) as IngestItemRow[];
    return rows.map(row => this.mapItem(row));
  }
  collectionReviewItems(reason: string): IngestJobItem[] {
    const rows = this.db.prepare(`SELECT i.* FROM ingest_job_items i
      JOIN ingest_jobs j ON j.id=i.job_id
      WHERE j.plan_only=0 AND i.state IN ('discovered','failed','complete')
      AND json_extract(i.action_json,'$.action_type')='error'
      AND json_extract(i.action_json,'$.reason')=?
      ORDER BY i.updated_at DESC`).all(reason) as IngestItemRow[];
    return rows.map(row => this.mapItem(row));
  }
  registerCollectionAction(jobId: string, action: OrganizationAction, source: string, serialize: (itemId: string) => string): string {
    const itemId = randomUUID();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO ingest_job_items VALUES(?,?,?,?,0,NULL,NULL,?)')
        .run(itemId, jobId, 'discovered', JSON.stringify(action), Date.now());
      this.touch(jobId);
      this.writeCollection(source, serialize(itemId));
    })();
    this.notify(itemId);
    return itemId;
  }
  private itemListeners: Array<(item: IngestJobItem) => void> = [];
  onItemUpdated(listener: (item: IngestJobItem) => void): void { this.itemListeners.push(listener); }
  getItem(id: string): IngestJobItem | undefined {
    const row = this.db.prepare('SELECT * FROM ingest_job_items WHERE id=?').get(id) as IngestItemRow | undefined;
    return row ? this.mapItem(row) : undefined;
  }
  create(targetDir:string, libraryId?:string, planOnly=false): string { const id=randomUUID(), now=Date.now(); this.db.prepare('INSERT INTO ingest_jobs(id,state,target_dir,library_id,plan_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'discovered',targetDir,libraryId??null,planOnly?1:0,now,now); return id; }
  addItem(jobId:string, action:OrganizationAction): string { const id=randomUUID(); this.db.prepare('INSERT INTO ingest_job_items VALUES(?,?,?,?,0,NULL,NULL,?)').run(id,jobId,'discovered',JSON.stringify(action),Date.now()); this.touch(jobId); this.notify(id); return id; }
  transitionItem(id:string,state:IngestState,error?:string|null,absItemId?:string|null):void {
    const row=this.db.prepare('SELECT job_id FROM ingest_job_items WHERE id=?').get(id) as {job_id:string}|undefined;
    if(!row) throw new Error('Ingest item not found');
    this.db.prepare('UPDATE ingest_job_items SET state=?,error=?,abs_item_id=COALESCE(?,abs_item_id),attempts=attempts+1,updated_at=? WHERE id=?').run(state,error??null,absItemId??null,Date.now(),id);
    this.recompute(row.job_id);
    this.notify(id);
  }
  /**
   * Every state change must reach the listeners, not just `transitionItem`.
   * Acquisitions are correlated to ingest items through this hook; a held
   * duplicate or a discarded item that never notified left its acquisition
   * parked on "importing" forever.
   */
  private notify(id:string):void {
    const updated = this.getItem(id);
    if (!updated) return;
    for (const listener of this.itemListeners) {
      try { listener(updated); } catch (e) { console.error('Error in ingest item listener:', e); }
    }
  }
  discardItem(id:string):boolean {
    const row=this.db.prepare("SELECT job_id FROM ingest_job_items WHERE id=? AND state IN ('discovered','failed')").get(id) as {job_id:string}|undefined;
    if(!row) return false;
    const result=this.db.prepare("UPDATE ingest_job_items SET state='discarded',error=NULL,updated_at=? WHERE id=? AND state IN ('discovered','failed')").run(Date.now(),id);
    if(result.changes===0) return false;
    this.recompute(row.job_id);
    this.notify(id);
    return true;
  }
  discardPendingItemsBySourcePath(sourcePath:string):number {
    const resolvedSource = path.resolve(sourcePath);
    const candidates = this.pendingReviewItems();
    const matches = candidates.filter((item) => path.resolve(item.action.source_path) === resolvedSource);
    const discard = this.db.transaction((items:IngestJobItem[]) => {
      const now = Date.now();
      const jobIds = new Set<string>();
      const discardedIds:string[] = [];
      for (const item of items) {
        const result = this.db.prepare("UPDATE ingest_job_items SET state='discarded',error=NULL,updated_at=? WHERE id=? AND state IN ('discovered','failed')").run(now,item.id);
        if (result.changes > 0) { jobIds.add(item.jobId); discardedIds.push(item.id); }
      }
      for (const jobId of jobIds) this.recompute(jobId);
      return discardedIds;
    });
    // Notify after the transaction commits so a listener never observes (or
    // writes through) a half-applied batch.
    for (const id of discard(matches)) this.notify(id);
    return matches.length;
  }
  /**
   * Dismiss every item for a source path in any state. Used after a rollback
   * puts a book back in the inbox: its job finished long ago, so without a
   * dismissal the poller treats the restored folder as new and imports it again.
   */
  discardItemsBySourcePath(sourcePath:string):number {
    const resolved = path.resolve(sourcePath);
    const rows = this.db.prepare(`SELECT i.id,i.job_id,i.action_json FROM ingest_job_items i WHERE i.state!='discarded'`).all() as Array<{id:string;job_id:string;action_json:string}>;
    const ids:string[] = [];
    const jobIds = new Set<string>();
    const now = Date.now();
    this.db.transaction(() => {
      for (const row of rows) {
        let source: string | undefined;
        try { source = (JSON.parse(row.action_json) as OrganizationAction).source_path; } catch { continue; }
        if (!source || path.resolve(source) !== resolved) continue;
        this.db.prepare("UPDATE ingest_job_items SET state='discarded',error=NULL,updated_at=? WHERE id=?").run(now,row.id);
        ids.push(row.id);
        jobIds.add(row.job_id);
      }
      for (const jobId of jobIds) this.recompute(jobId);
    })();
    for (const id of ids) this.notify(id);
    return ids.length;
  }
  pendingReviewItems():IngestJobItem[] {
    const rows = this.db.prepare(`SELECT i.* FROM ingest_job_items i
      JOIN ingest_jobs j ON j.id=i.job_id
      WHERE j.plan_only=0 AND i.state IN ('discovered','failed')
      AND NOT EXISTS (SELECT 1 FROM ingest_collection_archive_parents b WHERE b.item_id=i.id)
      ORDER BY i.updated_at DESC`).all() as IngestItemRow[];
    return rows.map((row) => this.mapItem(row)).filter((item) => (
      item.state === 'failed' || item.action.action_type === 'duplicate' || item.action.action_type === 'error'
    ));
  }
  cancelJob(id:string):void { this.db.prepare("UPDATE ingest_job_items SET state='cancelled',updated_at=? WHERE job_id=? AND state NOT IN ('complete','cancelled')").run(Date.now(),id); this.db.prepare("UPDATE ingest_jobs SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(),id); }
  get(id:string):IngestJob|undefined { const job=this.db.prepare('SELECT * FROM ingest_jobs WHERE id=?').get(id) as IngestJobRow|undefined; return job?this.map(job):undefined; }
  list():IngestJob[] { return (this.db.prepare('SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 100').all() as IngestJobRow[]).map(r=>this.map(r)); }
  hasActiveJobForTarget(targetDir: string): boolean {
    if (this.readCollection(path.resolve(targetDir))) return true;
    const row = this.db.prepare(`SELECT 1 FROM ingest_jobs j WHERE j.target_dir=? AND j.state NOT IN ('complete', 'cancelled')
      AND (NOT EXISTS (SELECT 1 FROM ingest_job_items i WHERE i.job_id=j.id)
        OR EXISTS (SELECT 1 FROM ingest_job_items i LEFT JOIN ingest_collection_archive_parents b ON i.id=b.item_id
          WHERE i.job_id=j.id AND b.item_id IS NULL))`).get(targetDir);
    return !!row;
  }
  /**
   * When an item for this inbox path was last dismissed, or null if never.
   * Dismissing leaves the files on disk and completes the job, so without this
   * the poller rediscovered the same folder on its next pass and the item came
   * straight back.
   */
  lastDismissedAt(targetPath:string):number|null {
    const resolved=path.resolve(targetPath);
    const row=this.db.prepare(`SELECT MAX(i.updated_at) AS at FROM ingest_job_items i JOIN ingest_jobs j ON j.id=i.job_id
      WHERE i.state='discarded' AND (j.target_dir=? OR json_extract(i.action_json,'$.source_path')=?)`).get(resolved,resolved) as {at:number|null}|undefined;
    return row?.at ?? null;
  }
  close():void { this.db.close(); }
  private mapItem(i:IngestItemRow):IngestJobItem { return {id:i.id,jobId:i.job_id,state:i.state,action:JSON.parse(i.action_json) as OrganizationAction,attempts:i.attempts,error:i.error,absItemId:i.abs_item_id,updatedAt:i.updated_at}; }
  private map(r:IngestJobRow):IngestJob { const items=(this.db.prepare('SELECT * FROM ingest_job_items WHERE job_id=? ORDER BY updated_at').all(r.id) as IngestItemRow[]).map(i=>this.mapItem(i)); return {id:r.id,state:r.state,targetDir:r.target_dir,libraryId:r.library_id,planOnly:r.plan_only===1,createdAt:r.created_at,updatedAt:r.updated_at,items}; }
  private touch(id:string):void { this.db.prepare('UPDATE ingest_jobs SET updated_at=? WHERE id=?').run(Date.now(),id); }
  private recompute(id:string):void { const states=(this.db.prepare('SELECT state FROM ingest_job_items WHERE job_id=?').all(id) as Array<{state:IngestState}>).map(r=>r.state); const state:IngestState=states.some(s=>s==='failed')?'failed':states.length&&states.every(s=>s==='complete'||s==='discarded')?'complete':states.some(s=>s==='staging')?'staging':'discovered'; this.db.prepare('UPDATE ingest_jobs SET state=?,updated_at=? WHERE id=?').run(state,Date.now(),id); }
}
