import React from 'react';
import { type Comment } from '../api/client';

interface ReviewHistoryProps {
  comments: Comment[];
}

function getEventType(body: string): 'approved' | 'changes_requested' | 'processing' | 'complete' | 'error' | null {
  if (body.startsWith('**[review:approved]**')) return 'approved';
  if (body.startsWith('**[review:changes_requested]**')) return 'changes_requested';
  if (body.startsWith('[status:processing]')) return 'processing';
  if (body.startsWith('[status:complete]')) return 'complete';
  if (body.startsWith('[status:error]')) return 'error';
  return null;
}

const EVENT_ICON: Record<string, string> = {
  approved: '✅',
  changes_requested: '🔄',
  processing: '⏳',
  complete: '✔',
  error: '⚠️',
};

const EVENT_LABEL: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  processing: 'Processing',
  complete: 'Complete',
  error: 'Error',
};

const EVENT_COLOR: Record<string, string> = {
  approved: 'var(--color-success)',
  changes_requested: 'var(--color-warning)',
  processing: 'var(--color-text-secondary)',
  complete: 'var(--color-success)',
  error: 'var(--color-error)',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getBodyText(body: string, eventType: string): string {
  // Strip the tag prefix to get just the message content
  if (eventType === 'approved') {
    return body.replace(/^\*\*\[review:approved\]\*\*\s*/, '').replace(/^Approved by [^\n]+\n?/, '').trim();
  }
  if (eventType === 'changes_requested') {
    return body.replace(/^\*\*\[review:changes_requested\]\*\*\s*/, '').replace(/^Changes requested by [^\n]+\n?/, '').trim();
  }
  if (eventType === 'processing') {
    return body.replace(/^\[status:processing\]\s*/, '').trim();
  }
  if (eventType === 'complete') {
    return body.replace(/^\[status:complete\]\s*/, '').trim();
  }
  if (eventType === 'error') {
    return body.replace(/^\[status:error\]\s*/, '').trim();
  }
  return body;
}

export function ReviewHistory({ comments }: ReviewHistoryProps) {
  const events = comments
    .filter(c => {
      const body = c.body ?? '';
      return body.startsWith('**[review:') || body.startsWith('[status:');
    })
    .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

  if (events.length === 0) {
    return (
      <div style={{ padding: '12px 20px', color: 'var(--color-text-secondary)', fontSize: 13 }}>
        No review history yet.
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 20px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {events.map((c, idx) => {
          const eventType = getEventType(c.body ?? '');
          if (!eventType) return null;
          const icon = EVENT_ICON[eventType];
          const label = EVENT_LABEL[eventType];
          const color = EVENT_COLOR[eventType];
          const detail = getBodyText(c.body ?? '', eventType);
          const isLast = idx === events.length - 1;

          return (
            <div key={c.id} style={{ display: 'flex', gap: 12, position: 'relative' }}>
              {/* Timeline connector */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 24, flexShrink: 0 }}>
                <div style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: 'var(--color-bg-secondary)',
                  border: `2px solid ${color}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  zIndex: 1,
                  flexShrink: 0,
                }}>
                  {icon}
                </div>
                {!isLast && (
                  <div style={{
                    width: 2,
                    flex: 1,
                    minHeight: 16,
                    background: 'var(--color-border)',
                  }} />
                )}
              </div>

              {/* Event content */}
              <div style={{ paddingBottom: isLast ? 0 : 16, paddingTop: 2, flex: 1, minWidth: 0 }}>
                <div className="flex gap-2 items-center" style={{ marginBottom: detail ? 4 : 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    by {c.author}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    · {formatRelativeTime(c.created)}
                  </span>
                </div>
                {detail && (
                  <div style={{
                    fontSize: 13,
                    color: 'var(--color-text-secondary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
