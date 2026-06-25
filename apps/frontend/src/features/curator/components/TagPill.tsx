import type { BookTag, TagCategory } from '../api';

export function TagPill({ tag, category }: { tag: string; category: TagCategory }) {
  return <span className={`pill ${category}`}>{tag}</span>;
}

/** Top-N tag cloud for a book card (the signature element). */
export function TagCloud({ tags, max = 5 }: { tags: BookTag[]; max?: number }) {
  const top = [...tags].sort((a, b) => b.confidence - a.confidence).slice(0, max);
  if (top.length === 0) return <span className="muted" style={{ fontSize: 11 }}>untagged</span>;
  return (
    <div>
      {top.map((t) => (
        <TagPill key={t.id} tag={t.tag} category={t.category} />
      ))}
    </div>
  );
}
