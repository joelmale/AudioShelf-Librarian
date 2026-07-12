import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, BookOpenCheck, Bot, ChevronDown, CirclePlus, Download, FolderCog, LayoutDashboard, Menu, Search, Settings as SettingsIcon, Sparkles, WandSparkles, X } from "lucide-react";
import React from "react";
import { DeskPage } from "./pages/DeskPage.js";
import { ScoutPage } from "./pages/ScoutPage.js";
import { ProcessPage } from "./pages/ProcessPage.js";
import { CuratePage } from "./pages/CuratePage.js";
import { useHealth, useOperations } from "../features/curator/api.js";
import { BookDetail } from "../features/curator/pages/BookDetail.js";
import { CollectionDetail } from "../features/curator/pages/CollectionDetail.js";
import { EncoderPage } from "../features/curator/features/encoder/pages/EncoderPage.js";
import { JobDetailPage } from "../features/curator/features/encoder/pages/JobDetailPage.js";
import { UnifiedLogsPage } from "../features/logs/UnifiedLogsPage.js";
import { PreviewSettingsDialog } from "./components/PreviewSettingsDialog.js";
import "./preview.css";

const NAV = [
  ["desk", "Desk", LayoutDashboard], ["scout/trends", "Scout & Acquire", Search],
  ["curate/review", "Curate", BookOpenCheck],
  ["process/scan", "Process", FolderCog], ["activity", "Activity", Activity],
] as const;

function PreviewShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const health = useHealth();
  const operations = useOperations();
  const navigate = useNavigate();
  const location = useLocation();
  const active = (operations.data ?? []).find((op) => !["completed", "cancelled", "error"].includes(op.status));
  const pct = active?.progress?.total ? Math.round(active.progress.current / active.progress.total * 100) : 0;
  const title = NAV.find(([path]) => location.pathname.includes(`/preview/${path.split("/")[0]}`))?.[1] ?? "Librarian";

  const go = (path: string) => { setTaskOpen(false); setMobileOpen(false); navigate(`/preview/${path}`); };
  const openSettings = React.useCallback(() => setSettingsOpen(true), []);
  const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
  return (
    <div className="v2-app">
      <aside className={`v2-rail ${mobileOpen ? "is-open" : ""}`}>
        <div className="v2-brand"><span className="v2-brand-mark"><Sparkles /></span><span><strong>AudioShelf</strong><small>Librarian</small></span></div>
        <nav aria-label="Primary navigation">
          {NAV.map(([to, label, Icon]) => {
            const group = to.split("/")[0];
            return <NavLink key={to} to={`/preview/${to}`} onClick={() => setMobileOpen(false)} className={location.pathname.startsWith(`/preview/${group}`) ? "active" : ""}><Icon/><span>{label}</span></NavLink>;
          })}
        </nav>
        <div className="v2-connection"><span className={`v2-dot ${health.data?.absConnected ? "ok" : "bad"}`}/><span>Audiobookshelf<small>{health.isLoading ? "Checking…" : health.data?.absConnected ? "Connected" : "Unavailable"}</small></span></div>
      </aside>

      <section className="v2-workspace">
        <header className="v2-topbar">
          <button className="v2-icon-button v2-mobile-menu" aria-label="Open menu" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X/> : <Menu/>}</button>
          <div className="v2-mobile-title"><strong>{title}</strong><small><span className="v2-dot ok"/> Live system</small></div>
          <button className="v2-command" onClick={() => go("scout/search")}><Search/><span>Ask your librarian or search tasks…</span><kbd>Ctrl K</kbd></button>
          {active && <button className="v2-active-top" onClick={() => go(`activity/${active.id}`)}><Bot/><span>{active.type}</span><strong>{pct}%</strong></button>}
          <button className="v2-button v2-new-task" onClick={() => setTaskOpen(true)}><CirclePlus/> New task</button>
          <button className="v2-icon-button v2-settings-trigger" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/></button>
        </header>
        <main className="v2-main"><Routes>
          <Route path="desk" element={<DeskPage/>}/>
          <Route path="scout/trends" element={<ScoutPage mode="trends"/>}/>
          <Route path="scout/search" element={<ScoutPage mode="search"/>}/>
          <Route path="acquire/downloads" element={<Navigate to="/preview/scout/search" replace/>}/>
          <Route path="acquire/intake" element={<Navigate to="/preview/process/scan" replace/>}/>
          <Route path="curate/review" element={<CuratePage section="books"/>}/>
          <Route path="curate/books/:id" element={<div className="v2-page v2-curate-surface"><BookDetail backPath="/preview/curate/review"/></div>}/>
          <Route path="curate/encode" element={<CuratePage section="encode"/>}/>
          <Route path="curate/encode/jobs" element={<div className="v2-page v2-curate-surface"><JobDetailPage backPath="/preview/curate/encode"/></div>}/>
          <Route path="curate/collections" element={<CuratePage section="collections"/>}/>
          <Route path="curate/collections/:id" element={<div className="v2-page v2-curate-surface"><CollectionDetail collectionsPath="/preview/curate/collections" booksPath="/preview/curate/books"/></div>}/>
          <Route path="curate/tags" element={<CuratePage section="tags"/>}/>
          <Route path="process/scan" element={<ProcessPage mode="scan"/>}/>
          <Route path="process/review" element={<ProcessPage mode="review"/>}/>
          <Route path="process/organize" element={<ProcessPage mode="review"/>}/>
          <Route path="process/encode" element={<EncoderPage/>}/>
          <Route path="process/encode/jobs" element={<JobDetailPage/>}/>
          <Route path="activity" element={<UnifiedLogsPage/>}/>
          <Route path="activity/:id" element={<UnifiedLogsPage/>}/>
          <Route path="settings" element={<SettingsDeepLink onOpen={openSettings}/>}/>
          <Route path="*" element={<Navigate to="desk" replace/>}/>
        </Routes></main>
      </section>

      {active && <button className="v2-job-capsule" onClick={() => go(`activity/${active.id}`)}><span><strong>{active.type}</strong><small>{active.progress.message || active.status}</small></span><b>{pct}%</b></button>}
      <nav className="v2-bottom-nav" aria-label="Mobile navigation">
        {[["desk","Desk",LayoutDashboard],["scout/trends","Scout & Acquire",Search],["curate/review","Curate",BookOpenCheck],["activity","Activity",Activity]].map(([to,label,Icon]: any) => <NavLink key={to} to={`/preview/${to}`}><Icon/><span>{label}</span></NavLink>)}
        <button type="button" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/><span>Settings</span></button>
      </nav>
      <button className="v2-mobile-fab" aria-label="New task" onClick={() => setTaskOpen(true)}><CirclePlus/></button>

      {taskOpen && <div className="v2-overlay" onMouseDown={() => setTaskOpen(false)}><section className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(e) => e.stopPropagation()}><div className="v2-sheet-handle"/><div className="v2-sheet-head"><div><span className="v2-eyebrow">Live system</span><h2 id="new-task-title">Start a task</h2></div><button className="v2-icon-button" onClick={() => setTaskOpen(false)}><X/></button></div><div className="v2-task-grid">
        <button onClick={() => go("scout/search")}><Download/><span><strong>Acquire</strong><small>Find and send a title to downloads</small></span><ChevronDown/></button>
        <button onClick={() => go("process/scan")}><Search/><span><strong>Scan</strong><small>Inspect an intake directory</small></span><ChevronDown/></button>
        <button onClick={() => go("process/organize")}><FolderCog/><span><strong>Organize</strong><small>Review proposed filesystem changes</small></span><ChevronDown/></button>
        <button onClick={() => go("curate/encode")}><WandSparkles/><span><strong>Convert</strong><small>Review books that need M4B</small></span><ChevronDown/></button>
      </div></section></div>}
      <PreviewSettingsDialog open={settingsOpen} onClose={closeSettings}/>
    </div>
  );
}

function SettingsDeepLink({ onOpen }: { onOpen: () => void }) {
  React.useEffect(() => { onOpen(); }, [onOpen]);
  return <Navigate to="/preview/desk" replace/>;
}

export default function PreviewApp() {
  return <div id="ui-v2-root" data-ui-version="v2"><div id="ui-v2-portals"/><PreviewShell/></div>;
}
