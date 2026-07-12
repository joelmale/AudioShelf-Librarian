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
          <span className="v2-eyebrow">UI v2 isolated safely</span>
          <h1>The main interface hit a problem.</h1>
          <p>{this.state.error.message}</p>
          <div className="v2-actions">
            <button className="v2-button" onClick={() => window.location.reload()}>Reload UI v2</button>
            <Link className="v2-button v2-button-secondary" to="/classic">Open classic UI</Link>
          </div>
        </div>
      </div>
    );
  }
}
