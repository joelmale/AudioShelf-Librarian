import { NavLink, Route, Routes } from 'react-router-dom';
import {
  AudioLines,
  BookOpen,
  LayoutDashboard,
  Library,
  Settings as SettingsIcon,
  Sparkles,
  Tags,
} from 'lucide-react';

import { useHealth } from './api';
import { Dashboard } from './pages/Dashboard';
import { Books } from './pages/Books';
import { BookDetail } from './pages/BookDetail';
import { Tagging } from './pages/Tagging';
import { Collections } from './pages/Collections';
import { CollectionDetail } from './pages/CollectionDetail';
import { EncoderPage } from './features/encoder/pages/EncoderPage';
import { JobDetailPage } from './features/encoder/pages/JobDetailPage';

const NAV = [
  { to: '', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: 'books', label: 'Books', icon: BookOpen, end: false },
  { to: 'tag', label: 'Tagging', icon: Tags, end: false },
  { to: 'collections', label: 'Collections', icon: Library, end: false },
  { to: 'encode', label: 'Encode', icon: AudioLines, end: false },
];

export function App() {
  const health = useHealth();
  const connected = health.data?.absConnected;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Sparkles size={18} style={{ verticalAlign: -3, marginRight: 6 }} />
          ABS Curator
        </div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
        <div className="conn">
          <span className={`dot ${health.isLoading ? '' : connected ? 'ok' : 'bad'}`} />
          {health.isLoading ? 'Checking ABS…' : connected ? 'ABS connected' : 'ABS unreachable'}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="" element={<Dashboard />} />
          <Route path="books" element={<Books />} />
          <Route path="books/:id" element={<BookDetail />} />
          <Route path="tag" element={<Tagging />} />
          <Route path="collections" element={<Collections />} />
          <Route path="collections/:id" element={<CollectionDetail />} />
          <Route path="encode" element={<EncoderPage />} />
          <Route path="encode/jobs" element={<JobDetailPage />} />
        </Routes>
      </main>
    </div>
  );
}
