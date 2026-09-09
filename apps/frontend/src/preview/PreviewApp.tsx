import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, BookOpenCheck, Bot, ChevronDown, CirclePlus, Download, FolderCog, FolderInput, LayoutDashboard, Menu, MessageCircle, Search, Settings as SettingsIcon, Sparkles, WandSparkles, X } from "lucide-react";
import React from "react";
import { DeskPage } from "./pages/DeskPage.js";
import { useHealth, useOperations } from "../features/curator/api.js";
import "./preview.css";

const AskPage = React.lazy(async () => ({ default: (await import("./pages/AskPage.js")).AskPage }));
const ScoutPage = React.lazy(async () => ({ default: (await import("./pages/ScoutPage.js")).ScoutPage }));
const CuratePage = React.lazy(async () => ({ default: (await import("./pages/CuratePage.js")).CuratePage }));
const BookDetail = React.lazy(async () => ({ default: (await import("../features/curator/pages/BookDetail.js")).BookDetail }));
const CollectionDetail = React.lazy(async () => ({ default: (await import("../features/curator/pages/CollectionDetail.js")).CollectionDetail }));
const JobDetailPage = React.lazy(async () => ({ default: (await import("../features/curator/features/encoder/pages/JobDetailPage.js")).JobDetailPage }));
const UnifiedLogsPage = React.lazy(async () => ({ default: (await import("../features/logs/UnifiedLogsPage.js")).UnifiedLogsPage }));
const PreviewSettingsDialog = React.lazy(async () => ({ default: (await import("./components/PreviewSettingsDialog.js")).PreviewSettingsDialog }));
const HealthReportPage = React.lazy(async () => ({ default: (await import("./pages/HealthReportPage.js")).HealthReportPage }));

const NAV = [
  ["desk", "Desk", LayoutDashboard],
  ["discover/charts", "Discover", Search],
  ["library/books", "Library", BookOpenCheck],
  ["activity", "Activity", Activity],
] as const;

const MOBILE_NAV = [
  ["desk", "Desk", LayoutDashboard],
  ["discover/charts", "Discover", Search],
  ["library/books", "Library", BookOpenCheck],
  ["activity", "Activity", Activity],
] as const;

const NAV_GROUPS: Record<string, string[]> = {
  desk: ["/desk"],
  "discover/charts": ["/discover", "/scout", "/acquire"],
  "library/books": ["/library", "/curate", "/process/realign", "/process/encode"],
  activity: ["/activity"],
};

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return isMobile;
}

function PreserveRedirect({ to, tail = "" }: { to: string; tail?: string }) {
  const location = useLocation();
  return <Navigate to={{ pathname: `${to}${tail}`, search: location.search, hash: location.hash }} state={location.state} replace />;
}

function useDialogFocus(open: boolean, requestClose: () => void, dialogRef: React.RefObject<HTMLElement>, initialRef: React.RefObject<HTMLElement>, returnRef: React.MutableRefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const returnElement = returnRef.current;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => initialRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnElement?.focus();
    };
  }, [dialogRef, initialRef, open, requestClose, returnRef]);
}

function DeferredRoute({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return <React.Suspense fallback={<div className="v2-route-loading" role="status">Loading {label}…</div>}>{children}</React.Suspense>;
}

function PreviewShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const health = useHealth();
  const operations = useOperations();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const taskReturnRef = React.useRef<HTMLElement | null>(null);
  const taskDialogRef = React.useRef<HTMLElement>(null);
  const taskCloseRef = React.useRef<HTMLButtonElement>(null);
  const active = (operations.data ?? []).find((op) => !["completed", "cancelled", "error"].includes(op.status));
  const pct = active?.progress?.total ? Math.round(active.progress.current / active.progress.total * 100) : 0;
  const title = location.pathname.startsWith("/ask") ? "Ask" : NAV.find(([path]) => NAV_GROUPS[path].some((prefix) => location.pathname.startsWith(prefix)))?.[1] ?? "Librarian";

  const closeTask = React.useCallback(() => setTaskOpen(false), []);
  const openTask = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    taskReturnRef.current = event.currentTarget;
    setTaskOpen(true);
  }, []);
  useDialogFocus(taskOpen, closeTask, taskDialogRef, taskCloseRef, taskReturnRef);
  const go = (path: string) => { setTaskOpen(false); setMobileOpen(false); navigate(`/${path}`); };
  const openSettings = React.useCallback(() => setSettingsOpen(true), []);
  const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
  const railTabIndex = isMobile && !mobileOpen ? -1 : undefined;
  React.useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileOpen(false);
      window.setTimeout(() => menuButtonRef.current?.focus(), 0);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);
  return (
    <div className="v2-app">
      <aside className={`v2-rail ${mobileOpen ? "is-open" : ""}`}>
        <div className="v2-brand"><span className="v2-brand-mark"><Sparkles /></span><span><strong>AudioShelf</strong><small>Librarian</small></span></div>
        <nav id="primary-navigation" aria-label="Primary navigation">
          {NAV.map(([to, label, Icon]) => {
            const isActive = NAV_GROUPS[to].some((prefix) => location.pathname.startsWith(prefix));
            return <Link key={to} to={`/${to}`} tabIndex={railTabIndex} aria-current={isActive ? "page" : undefined} onClick={() => setMobileOpen(false)} className={isActive ? "active" : ""}><Icon/><span>{label}</span></Link>;
          })}
        </nav>
        <div className="v2-connection"><span className={`v2-dot ${health.data?.absConnected ? "ok" : "bad"}`}/><span>Audiobookshelf<small>{health.isLoading ? "Checking…" : health.data?.absConnected ? "Connected" : "Unavailable"}</small></span></div>
      </aside>

      <section className="v2-workspace">
        <header className="v2-topbar">
          <button ref={menuButtonRef} className="v2-icon-button v2-mobile-menu" aria-label={mobileOpen ? "Close menu" : "Open menu"} aria-expanded={mobileOpen} aria-controls="primary-navigation" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X/> : <Menu/>}</button>
          <div className="v2-mobile-title"><strong>{title}</strong><small><span className="v2-dot ok"/> Live system</small></div>
          <button className="v2-command" onClick={() => go("discover/search")}><Search/><span>Search acquisition sources…</span><kbd>Ctrl K</kbd></button>
          {active && <button className="v2-active-top" onClick={() => go(`activity/${active.id}`)}><Bot/><span>{active.type}</span><strong>{pct}%</strong></button>}
          <NavLink className="v2-utility-link" to="/ask"><MessageCircle/><span>Ask</span></NavLink>
          <button className="v2-button v2-new-task" onClick={openTask}><CirclePlus/> New task</button>
          <button className="v2-icon-button v2-settings-trigger" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/></button>
        </header>
        <main className="v2-main"><Routes>
          <Route path="desk" element={<DeskPage/>}/>
          <Route path="ask" element={<DeferredRoute label="Ask"><AskPage/></DeferredRoute>}/>
          <Route path="discover" element={<PreserveRedirect to="/discover/charts" />}/>
          <Route path="discover/charts" element={<DeferredRoute label="Discover"><ScoutPage mode="trends"/></DeferredRoute>}/>
          <Route path="discover/for-you" element={<DeferredRoute label="recommendations"><ScoutPage mode="recommendations"/></DeferredRoute>}/>
          <Route path="discover/search" element={<DeferredRoute label="source search"><ScoutPage mode="search"/></DeferredRoute>}/>
          <Route path="scout/trends" element={<DeferredRoute label="Scout"><ScoutPage mode="trends"/></DeferredRoute>}/>
          <Route path="scout/search" element={<DeferredRoute label="Scout"><ScoutPage mode="search"/></DeferredRoute>}/>
          <Route path="scout/recommendations" element={<DeferredRoute label="recommendations"><ScoutPage mode="recommendations"/></DeferredRoute>}/>
          <Route path="scout/intake" element={<DeferredRoute label="intake"><ScoutPage mode="intake"/></DeferredRoute>}/>
          <Route path="acquire/downloads" element={<PreserveRedirect to="/discover/search" />}/>
          <Route path="acquire/intake" element={<PreserveRedirect to="/scout/intake" />}/>
          <Route path="library" element={<PreserveRedirect to="/library/books" />}/>
          <Route path="library/books" element={<DeferredRoute label="Library"><CuratePage section="books"/></DeferredRoute>}/>
          <Route path="library/books/:id" element={<DeferredRoute label="book details"><div className="v2-page v2-curate-surface"><BookDetail backPath="/library/books"/></div></DeferredRoute>}/>
          <Route path="library/collections" element={<DeferredRoute label="collections"><CuratePage section="collections"/></DeferredRoute>}/>
          <Route path="library/collections/:id" element={<DeferredRoute label="collection details"><div className="v2-page v2-curate-surface"><CollectionDetail collectionsPath="/library/collections" booksPath="/library/books"/></div></DeferredRoute>}/>
          <Route path="library/manage" element={<DeferredRoute label="manage library"><CuratePage section="manage"/></DeferredRoute>}/>
          <Route path="library/manage/metadata" element={<DeferredRoute label="metadata"><CuratePage section="metadata"/></DeferredRoute>}/>
          <Route path="library/manage/files" element={<DeferredRoute label="file organization"><CuratePage section="files"/></DeferredRoute>}/>
          <Route path="library/manage/audio" element={<DeferredRoute label="audio conversion"><CuratePage section="audio"/></DeferredRoute>}/>
          <Route path="library/manage/audio/jobs" element={<DeferredRoute label="encode history"><div className="v2-page v2-curate-surface"><JobDetailPage backPath="/library/manage/audio"/></div></DeferredRoute>}/>
          <Route path="library/manage/health" element={<DeferredRoute label="library health"><HealthReportPage/></DeferredRoute>}/>
          <Route path="curate/review" element={<DeferredRoute label="Curate"><CuratePage section="books"/></DeferredRoute>}/>
          <Route path="curate/books/:id" element={<DeferredRoute label="book details"><div className="v2-page v2-curate-surface"><BookDetail backPath="/curate/review"/></div></DeferredRoute>}/>
          <Route path="curate/encode" element={<DeferredRoute label="M4B candidates"><CuratePage section="encode"/></DeferredRoute>}/>
          <Route path="curate/encode/jobs" element={<DeferredRoute label="encode history"><div className="v2-page v2-curate-surface"><JobDetailPage backPath="/curate/encode"/></div></DeferredRoute>}/>
          <Route path="curate/collections" element={<DeferredRoute label="collections"><CuratePage section="collections"/></DeferredRoute>}/>
          <Route path="curate/collections/:id" element={<DeferredRoute label="collection details"><div className="v2-page v2-curate-surface"><CollectionDetail collectionsPath="/curate/collections" booksPath="/curate/books"/></div></DeferredRoute>}/>
          <Route path="curate/tags" element={<DeferredRoute label="tags"><CuratePage section="tags"/></DeferredRoute>}/>
          <Route path="curate/health" element={<DeferredRoute label="library health"><HealthReportPage/></DeferredRoute>}/>
          <Route path="curate/realign" element={<DeferredRoute label="realign"><CuratePage section="realign"/></DeferredRoute>}/>
          <Route path="process/scan" element={<PreserveRedirect to="/scout/intake" />}/>
          <Route path="process/review" element={<PreserveRedirect to="/scout/intake" />}/>
          <Route path="process/organize" element={<PreserveRedirect to="/scout/intake" />}/>
          <Route path="process/realign" element={<PreserveRedirect to="/library/manage/files" />}/>
          <Route path="process/encode" element={<PreserveRedirect to="/library/manage/audio" />}/>
          <Route path="process/encode/jobs" element={<PreserveRedirect to="/library/manage/audio/jobs" />}/>
          <Route path="activity" element={<DeferredRoute label="activity"><UnifiedLogsPage/></DeferredRoute>}/>
          <Route path="activity/:id" element={<DeferredRoute label="activity"><UnifiedLogsPage/></DeferredRoute>}/>
          <Route path="settings" element={<SettingsDeepLink onOpen={openSettings}/>}/>
          <Route path="*" element={<Navigate to="desk" replace/>}/>
        </Routes></main>
      </section>

      {active && <button className="v2-job-capsule" onClick={() => go(`activity/${active.id}`)}><span><strong>{active.type}</strong><small>{active.progress.message || active.status}</small></span><b>{pct}%</b></button>}
      <nav className="v2-bottom-nav" aria-label="Mobile navigation">
        {MOBILE_NAV.map(([to,label,Icon]) => {
          const isActive = NAV_GROUPS[to].some((prefix) => location.pathname.startsWith(prefix));
          return <Link key={to} to={`/${to}`} aria-current={isActive ? "page" : undefined} className={isActive ? "active" : ""}><Icon/><span>{label}</span></Link>;
        })}
        <button type="button" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/><span>Settings</span></button>
      </nav>
      <button className="v2-mobile-fab" aria-label="New task" onClick={openTask}><CirclePlus/></button>

      {taskOpen && <div className="v2-overlay" onMouseDown={closeTask}><section ref={taskDialogRef} className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(e) => e.stopPropagation()}><div className="v2-sheet-handle"/><div className="v2-sheet-head"><div><span className="v2-eyebrow">Live system</span><h2 id="new-task-title">Start a task</h2></div><button ref={taskCloseRef} className="v2-icon-button" aria-label="Close task" onClick={closeTask}><X/></button></div><div className="v2-task-grid">
        <button onClick={() => go("discover/search")}><Download/><span><strong>Acquire</strong><small>Find and send a title to downloads</small></span><ChevronDown/></button>
        <button onClick={() => go("scout/intake")}><FolderCog/><span><strong>Intake</strong><small>Review conflicts that need a decision</small></span><ChevronDown/></button>
        <button onClick={() => go("library/manage/files")}><FolderInput/><span><strong>Realign</strong><small>Fix directory structure</small></span><ChevronDown/></button>
        <button onClick={() => go("library/manage/audio")}><WandSparkles/><span><strong>Convert</strong><small>Review books that need M4B</small></span><ChevronDown/></button>
      </div></section></div>}
      {settingsOpen && <DeferredRoute label="settings"><PreviewSettingsDialog open onClose={closeSettings}/></DeferredRoute>}
    </div>
  );
}

function SettingsDeepLink({ onOpen }: { onOpen: () => void }) {
  const location = useLocation();
  React.useEffect(() => { onOpen(); }, [onOpen]);
  return <Navigate to={{ pathname: "/discover/charts", search: location.search, hash: location.hash }} state={location.state} replace/>;
}

export default function PreviewApp() {
  return <div id="ui-v2-root" data-ui-version="v2"><div id="ui-v2-portals"/><PreviewShell/></div>;
}
