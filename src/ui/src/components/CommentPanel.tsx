import React, { useState } from 'react';
import { useUIStore } from '../store/ui';
import { apiClient, type Comment } from '../api/client';

interface CommentPanelProps {
  docId: string;
  comments: Comment[];
  onCommentAdded: () => void;
  onCommentResolved: () => void;
}

function groupByThread(comments: Comment[]) {
  const topLevel = comments.filter((c) => !c.parent);
  const replies = comments.filter((c) => c.parent);

  return topLevel.map((parent) => ({
    parent,
    replies: replies.filter((r) => r.parent === parent.id),
  }));
}

function CommentItem({
  comment,
  docId,
  onResolved,
}: {
  comment: Comment;
  docId: string;
  onResolved: () => void;
}) {
  const [resolving, setResolving] = useState(false);

  const handleResolve = async () => {
    setResolving(true);
    try {
      await apiClient.patch(
        `/documents/${docId}/comments/${comment.id}`,
        { resolved: true }
      );
      onResolved();
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      className={`comment-item${comment.resolved ? ' comment-resolved' : ''}`}
    >
      {comment.anchor_lost && (
        <div className="comment-anchor-lost">
          ⚠️ Anchor lost — document was updated after this comment
        </div>
      )}
      <div className="comment-meta">
        <span className="comment-author">{comment.author}</span>
        <span>·</span>
        <span>{new Date(comment.created).toLocaleString()}</span>
        <span>·</span>
        <span>round {comment.round}</span>
        {comment.resolved && <span style={{ color: 'var(--color-success)' }}>✓ resolved</span>}
      </div>
      <div className="comment-body">{comment.body}</div>
      {!comment.resolved && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleResolve}
          disabled={resolving}
          style={{ marginTop: 8 }}
        >
          {resolving ? 'Resolving...' : '✓ Resolve'}
        </button>
      )}
    </div>
  );
}

export function CommentPanel({
  docId,
  comments,
  onCommentAdded,
  onCommentResolved,
}: CommentPanelProps) {
  const commentPanelOpen = useUIStore((s) => s.commentPanelOpen);
  const setCommentPanelOpen = useUIStore((s) => s.setCommentPanelOpen);
  const pendingSelector = useUIStore((s) => s.pendingSelector);
  const setPendingSelector = useUIStore((s) => s.setPendingSelector);
  const activeAnnotationId = useUIStore((s) => s.activeAnnotationId);

  const [newCommentBody, setNewCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const threads = groupByThread(comments);

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentBody.trim()) return;

    setSubmitting(true);
    try {
      await apiClient.post(`/documents/${docId}/comments`, {
        body: newCommentBody,
        type: pendingSelector ? 'inline' : 'page',
        selector: pendingSelector ?? undefined,
      });
      setNewCommentBody('');
      setPendingSelector(null);
      onCommentAdded();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className={`comment-panel${commentPanelOpen ? ' open' : ''}`}>
      <div className="comment-panel-header">
        <span>Comments ({comments.length})</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setCommentPanelOpen(false)}
          aria-label="Close comment panel"
        >
          ✕
        </button>
      </div>

      <div className="comment-panel-body">
        {/* New comment form */}
        <form
          onSubmit={handleSubmitComment}
          style={{
            marginBottom: 20,
            padding: 12,
            border: '1px solid var(--color-primary)',
            borderRadius: 'var(--radius)',
            background: 'var(--color-primary-light)',
          }}
        >
          {/* Quoted selection anchor */}
          {pendingSelector ? (
            <div style={{ marginBottom: 10 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-muted)',
                marginBottom: 4,
              }}>
                Commenting on:
              </div>
              <div
                className="comment-quote"
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  borderLeftWidth: 3,
                  padding: '6px 10px',
                  background: 'var(--color-highlight)',
                  borderColor: 'var(--color-highlight-border)',
                  borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                }}
              >
                {pendingSelector.quote.exact.length > 160
                  ? `"${pendingSelector.quote.exact.slice(0, 160)}…"`
                  : `"${pendingSelector.quote.exact}"`}
              </div>
            </div>
          ) : (
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--color-text-muted)',
              marginBottom: 8,
            }}>
              Page-level comment
            </div>
          )}

          <textarea
            className="input"
            placeholder={
              pendingSelector
                ? 'Add inline comment on selected text…'
                : 'Add a comment on the whole document…'
            }
            value={newCommentBody}
            onChange={(e) => setNewCommentBody(e.target.value)}
            rows={3}
            autoFocus={!!pendingSelector}
          />
          <div className="flex gap-2 mt-2">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={submitting || !newCommentBody.trim()}
            >
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
            {pendingSelector && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setPendingSelector(null)}
                title="Remove selection anchor — post as page comment instead"
              >
                ✕ Clear selection
              </button>
            )}
          </div>
        </form>

        {/* Comment threads */}
        {threads.length === 0 ? (
          <div className="text-muted text-sm">
            No comments yet. Select text to add an inline comment, or write a
            page-level comment above.
          </div>
        ) : (
          threads.map(({ parent, replies }) => (
            <div
              key={parent.id}
              className="comment-thread"
              id={`comment-${parent.id}`}
              style={{
                outline:
                  activeAnnotationId === parent.id
                    ? '2px solid var(--color-primary)'
                    : undefined,
              }}
            >
              {parent.selector && (
                <div className="comment-quote">
                  "{parent.selector.quote.exact.slice(0, 150)}
                  {parent.selector.quote.exact.length > 150 ? '...' : ''}"
                </div>
              )}
              <CommentItem
                comment={parent}
                docId={docId}
                onResolved={onCommentResolved}
              />
              {replies.map((reply) => (
                <div
                  key={reply.id}
                  style={{
                    marginLeft: 12,
                    borderLeft: '2px solid var(--color-border)',
                  }}
                >
                  <CommentItem
                    comment={reply}
                    docId={docId}
                    onResolved={onCommentResolved}
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
