import React from "react";
import { Link } from "react-router-dom";

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
      <div id="ui-v2-root" data-ui-version="v2" className="v2-fatal">
        <div className="v2-card">
          <span className="v2-eyebrow">Preview isolated safely</span>
          <h1>The new interface hit a problem.</h1>
          <p>{this.state.error.message}</p>
          <div className="v2-actions">
            <button className="v2-button" onClick={() => window.location.reload()}>Reload preview</button>
            <Link className="v2-button v2-button-secondary" to="/">Return to classic UI</Link>
          </div>
        </div>
      </div>
    );
  }
}
