import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { EncodeQueueItem } from '../../../api';
import { Badge } from '../atoms/Badge';
import { useMutation, useInvalidate } from '../../../api';
import { api } from '../../../api';

import { EncodePizzaTracker } from './EncodePizzaTracker';

// ── Force-Remove Confirmation Dialog ──────────────────────────────────────────

function ForceRemoveDialog({
  item,
  onConfirm,
  onCancel,
}: {
  item: EncodeQueueItem;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          border: '1px solid var(--border-color, #ddd)',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '440px',
          width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.05rem' }}>
          Remove Running Encode?
        </h3>
        <p style={{ margin: '0 0 8px 0', color: 'var(--text-secondary, #555)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          <strong>{item.name}</strong> is currently being encoded by Audiobookshelf.
        </p>
        <p style={{ margin: '0 0 20px 0', color: 'var(--text-secondary, #555)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          AudioShelf will <strong>stop tracking</strong> this job, but ABS will continue
          encoding in the background. The result will appear after the next library rescan.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onCancel}>
            Keep
          </button>
          <button
            className="btn"
            style={{ background: 'var(--danger, #e53e3e)', color: '#fff', borderColor: 'var(--danger, #e53e3e)' }}
            onClick={onConfirm}
          >
            Remove from Queue
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sortable Queue Item ────────────────────────────────────────────────────────

function SortableQueueItem({
  item,
  onRemove,
  onForceRemove,
  onPromote,
}: {
  item: EncodeQueueItem;
  onRemove: (id: string) => void;
  onForceRemove: (id: string) => void;
  onPromote: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : 'auto',
    opacity: isDragging ? 0.5 : 1,
    padding: '12px',
    marginBottom: '8px',
    backgroundColor: 'var(--glass-bg, rgba(255, 255, 255, 0.5))',
    backdropFilter: 'var(--glass-blur, blur(16px))',
    WebkitBackdropFilter: 'var(--glass-blur, blur(16px))',
    border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.8))',
    boxShadow: 'var(--glass-shadow, 0 4px 24px rgba(0, 0, 0, 0.04))',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
  };

  const isRunning = item.status === 'running';

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Drag handle — only for queued items */}
        <div
          {...(isRunning ? {} : listeners)}
          style={{
            cursor: isRunning ? 'default' : 'grab',
            color: isRunning
              ? 'var(--text-disabled, #bbb)'
              : 'var(--text-secondary, #4a5a6a)',
          }}
        >
          ☰
        </div>
        <div style={{ flex: 1, minWidth: 0, color: 'var(--text-primary, #1a2a3a)' }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.name}
          </div>
          <div style={{ fontSize: '0.85em', color: 'var(--text-secondary, #4a5a6a)' }}>
            {item.author} • {(item.totalBytes / 1024 / 1024).toFixed(1)} MB
          </div>
        </div>
        <Badge status={item.status} />
        <div style={{ display: 'flex', gap: '4px' }}>
          {item.status === 'queued' && (
            <button className="btn icon" onClick={() => onPromote(item.id)} title="Promote to Top">
              ↑
            </button>
          )}
          {isRunning ? (
            <button
              className="btn icon"
              onClick={() => onForceRemove(item.id)}
              title="Force Remove (ABS continues in background)"
              style={{ color: 'var(--danger, #e53e3e)', borderColor: 'var(--danger, #e53e3e)' }}
            >
              ✕
            </button>
          ) : (
            <button className="btn icon" onClick={() => onRemove(item.id)} title="Remove">
              ✕
            </button>
          )}
        </div>
      </div>

      {item.status === 'running' && (
        <EncodePizzaTracker itemId={item.id} />
      )}
    </div>
  );
}

// ── EncodeQueueList ────────────────────────────────────────────────────────────

export function EncodeQueueList({ queue }: { queue: EncodeQueueItem[] }) {
  const invalidate = useInvalidate();
  const [confirmForceRemoveId, setConfirmForceRemoveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const reorder = useMutation({
    mutationFn: ({ id, sortOrder }: { id: string; sortOrder: number }) => api.encodeReorder(id, sortOrder),
    onSuccess: () => invalidate(['encodeQueue']),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.encodeRemove(id),
    onSuccess: () => invalidate(['encodeQueue']),
  });

  const forceRemove = useMutation({
    mutationFn: (id: string) => api.encodeCancel(id),
    onSuccess: () => {
      setConfirmForceRemoveId(null);
      invalidate(['encodeQueue']);
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id && over) {
      const newIndex = queue.findIndex((x) => x.id === over.id);

      // Calculate new sort order (interpolate between neighbors or just reassign all)
      // For simplicity, if we move it to newIndex, we assign it the sortOrder of the item that was at newIndex
      const targetSortOrder = queue[newIndex].sortOrder;
      reorder.mutate({ id: String(active.id), sortOrder: targetSortOrder });
    }
  };

  const handlePromote = (id: string) => {
    // Find min sort order and subtract 1
    const minOrder = queue.length > 0 ? Math.min(...queue.map((q) => q.sortOrder)) : 0;
    reorder.mutate({ id, sortOrder: minOrder - 1 });
  };

  const handleRemove = (id: string) => {
    remove.mutate(id);
  };

  const handleForceRemoveRequest = (id: string) => {
    setConfirmForceRemoveId(id);
  };

  const handleForceRemoveConfirm = () => {
    if (confirmForceRemoveId) {
      forceRemove.mutate(confirmForceRemoveId);
    }
  };

  if (!queue || queue.length === 0) {
    return <div className="muted" style={{ padding: '24px', textAlign: 'center' }}>Queue is empty.</div>;
  }

  const confirmItem = confirmForceRemoveId
    ? queue.find((q) => q.id === confirmForceRemoveId) ?? null
    : null;

  return (
    <>
      {confirmItem && (
        <ForceRemoveDialog
          item={confirmItem}
          onConfirm={handleForceRemoveConfirm}
          onCancel={() => setConfirmForceRemoveId(null)}
        />
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={queue.map((q) => q.id)} strategy={verticalListSortingStrategy}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {queue.map((item) => (
              <SortableQueueItem
                key={item.id}
                item={item}
                onRemove={handleRemove}
                onForceRemove={handleForceRemoveRequest}
                onPromote={handlePromote}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}
