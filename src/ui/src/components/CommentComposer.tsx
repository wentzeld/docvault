import React, { useState } from 'react';
import { apiClient } from '../api/client';
import type { CommentSelector } from '../api/client';

interface CommentComposerProps {
  docId: string;
  selector: CommentSelector;
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * Inline comment creation popover — shown when a text selection is made
 * or when a block-level tap fallback fires.
 */
export function CommentComposer({
  docId,
  selector,
  onSubmitted,
  onCancel,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;

    setSubmitting(true);
    setError('');
    try {
      await apiClient.post(`/documents/${docId}/comments`, {
        body,
        type: 'inline',
        selector,
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-primary)',
        borderRadius: 'var(--radius)',
        padding: 12,
        boxShadow: '0 4px 16px var(--color-shadow-md)',
        width: 300,
      }}
    >
      <div
        className="comment-quote"
        style={{ marginBottom: 8, fontSize: 12 }}
      >
        "{selector.quote.exact.slice(0, 80)}
        {selector.quote.exact.length > 80 ? '...' : ''}"
      </div>

      {error && (
        <div
          style={{
            color: 'var(--color-error)',
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <textarea
          className="input"
          placeholder="Add a comment..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          autoFocus
          style={{ marginBottom: 8 }}
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={submitting || !body.trim()}
          >
            {submitting ? 'Posting...' : 'Comment'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
