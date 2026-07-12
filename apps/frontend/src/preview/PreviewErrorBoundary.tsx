import React from "react";

export class PreviewErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-fatal">
        <div className="app-fatal-card">
          <span>AudioShelf Librarian</span>
          <h1>The application hit a problem.</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>Reload application</button>
        </div>
      </div>
    );
  }
}
