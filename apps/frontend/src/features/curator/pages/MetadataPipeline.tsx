import { PipelineRunsPanel } from '../components/PipelineRunsPanel';
import { TagAnalytics } from '../components/TagAnalytics';
import { VocabularySuggestionsPanel } from '../components/VocabularySuggestionsPanel';

/**
 * The metadata pipeline page (Curate -> Metadata, still routed at
 * `/curate/tags`). Was "Tagging": a tagging screen that grew title parsing,
 * enrichment and embeddings as a panel bolted on underneath, which read as
 * "tagging first, accessories after" — the opposite of the order the stages
 * actually run in. The page is now two halves: run the pipeline, then review
 * what it produced.
 *
 * See `components/PipelineRunsPanel.tsx` for the stages and the dependency
 * chain between them.
 */
export function MetadataPipeline() {
  return (
    <div>
      <h1>Metadata pipeline</h1>
      <p className="muted" style={{ margin: '-8px 0 0 0', maxWidth: '72ch' }}>
        Everything that turns a raw library entry into something the librarian can search: parse the title, enrich it
        into entities, tag it, embed the finished card.
      </p>

      <PipelineRunsPanel />

      <hr className="pipeline-rule" style={{ marginTop: 40 }} />

      <h2 style={{ marginTop: 0 }}>Review</h2>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 16px 0', maxWidth: '72ch' }}>
        What the runs above produced. The promotion queue is the one that feeds back into the pipeline — promoting or
        aliasing a term changes the vocabulary, which is a reason to re-run stage 3.
      </p>

      <VocabularySuggestionsPanel />

      <div style={{ marginTop: 40 }}>
        <TagAnalytics />
      </div>
    </div>
  );
}
