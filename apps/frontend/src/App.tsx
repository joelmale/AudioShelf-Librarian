import React, { Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { WebSocketProvider } from "./contexts/WebSocketProvider.js";
import { resolveLegacyRedirect } from "./legacyRedirects.js";
import { PreviewErrorBoundary } from "./preview/PreviewErrorBoundary.js";

const PreviewApp = React.lazy(() => import("./preview/PreviewApp.js"));
const ClassicApp = React.lazy(() => import("./classic/ClassicApp.js"));

function PreviewSurface() {
  return (
    <PreviewErrorBoundary>
      <Suspense fallback={<div className="preview-loading">Loading AudioShelf UI…</div>}>
        <PreviewApp />
      </Suspense>
    </PreviewErrorBoundary>
  );
}

function ClassicSurface() {
  return (
    <Suspense fallback={<div>Loading classic UI…</div>}>
      <ClassicApp />
    </Suspense>
  );
}

function LegacyRedirect() {
  const { pathname } = useLocation();
  return <Navigate to={resolveLegacyRedirect(pathname)} replace />;
}

export const App = () => (
  <WebSocketProvider>
    <Routes>
      <Route path="/preview/*" element={<PreviewSurface />} />
      <Route path="/classic/*" element={<ClassicSurface />} />

      <Route path="*" element={<LegacyRedirect />} />
    </Routes>
  </WebSocketProvider>
);
