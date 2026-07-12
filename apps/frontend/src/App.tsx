import React, { Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { WebSocketProvider } from "./contexts/WebSocketProvider.js";
import { resolveCompatibilityRedirect } from "./legacyRedirects.js";
import { PreviewErrorBoundary } from "./preview/PreviewErrorBoundary.js";

const PrimaryApp = React.lazy(() => import("./preview/PreviewApp.js"));

function PrimarySurface() {
  return (
    <PreviewErrorBoundary>
      <Suspense fallback={<div className="app-loading">Loading AudioShelf…</div>}>
        <PrimaryApp />
      </Suspense>
    </PreviewErrorBoundary>
  );
}

function CompatibilityRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: resolveCompatibilityRedirect(pathname), search, hash }} replace />;
}

export const App = () => (
  <WebSocketProvider>
    <Routes>
      <Route path="/preview/*" element={<CompatibilityRedirect />} />
      <Route path="/classic/*" element={<CompatibilityRedirect />} />
      <Route path="/curator/*" element={<CompatibilityRedirect />} />
      <Route path="/logs/*" element={<CompatibilityRedirect />} />
      <Route path="/status" element={<CompatibilityRedirect />} />
      <Route path="/*" element={<PrimarySurface />} />
    </Routes>
  </WebSocketProvider>
);
