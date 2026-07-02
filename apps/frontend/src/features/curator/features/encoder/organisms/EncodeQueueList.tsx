import React from 'react';
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
  arrayMove,
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

function SortableQueueItem({
  item,
  onRemove,
  onPromote,
}: {
  item: EncodeQueueItem;
  onRemove: (id: string) => void;
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
    backgroundColor: 'var(--surface-color, #1e1e1e)',
    border: '1px solid var(--border-color, #333)',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div {...listeners} style={{ cursor: 'grab', color: 'var(--muted-color, #888)' }}>
          ☰
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.name}
          </div>
          <div className="muted" style={{ fontSize: '0.85em' }}>
            {item.author} • {(item.totalBytes / 1024 / 1024).toFixed(1)} MB
          </div>
        </div>
        <Badge status={item.status} />
        <div style={{ display: 'flex', gap: '4px' }}>
          {item.status === 'queued' && (
            <>
              <button className="btn icon" onClick={() => onPromote(item.id)} title="Promote to Top">
                ↑
              </button>
              <button className="btn icon" onClick={() => onRemove(item.id)} title="Remove">
                ✕
              </button>
            </>
          )}
        </div>
      </div>
      
      {item.status === 'running' && (
        <EncodePizzaTracker itemId={item.id} />
      )}
    </div>
  );
}

export function EncodeQueueList({ queue }: { queue: EncodeQueueItem[] }) {
  const invalidate = useInvalidate();

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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id && over) {
      const oldIndex = queue.findIndex((x) => x.id === active.id);
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

  if (!queue || queue.length === 0) {
    return <div className="muted" style={{ padding: '24px', textAlign: 'center' }}>Queue is empty.</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={queue.map((q) => q.id)} strategy={verticalListSortingStrategy}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {queue.map((item) => (
            <SortableQueueItem
              key={item.id}
              item={item}
              onRemove={handleRemove}
              onPromote={handlePromote}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
