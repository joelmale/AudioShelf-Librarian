import { Link } from "react-router-dom";

import { LibrarianChatPanel } from "../../features/curator/components/LibrarianChatPanel.js";

export function AskPage() {
  return <div className="v2-page v2-ask-page">
    <div className="v2-page-heading">
      <div>
        <span className="v2-eyebrow">Ask your librarian</span>
        <h1>Find your next listen</h1>
        <p>Start with the books you own. Looking for something new stays a separate, verified discovery path.</p>
      </div>
    </div>
    <nav className="v2-ask-choices" aria-label="Recommendation scope">
      <span className="v2-ask-choice is-active">From my library</span>
      <Link className="v2-ask-choice" to="/discover/for-you">Something new</Link>
    </nav>
    <LibrarianChatPanel />
  </div>;
}
