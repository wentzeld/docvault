// Shared response types matching the API contract (FR-API-00)

export interface DocListItem {
  id: string;
  title: string;
  type: string;
  project: string;
  tags: string[];
  version: number;
  words: number;
  status: string; // workflow_status
  indexed: boolean; // embed_status === 'ready'
  created: string;
  updated: string;
  // Optional fields (omitted when null/false unless ?nulls=true)
  agent_id?: string;
  commented_at?: string;
  content?: string;
}

export interface DocDetail extends DocListItem {
  content: string;
  html: string;
  embed_status: string;
  embed_model?: string;
  metadata?: Record<string, unknown>;
  comments: number;
}

export interface CommentShape {
  id: string;
  doc: string;
  author: string;
  type: string;
  body: string;
  round: number;
  created: string;
  updated: string;
  // Conditionally included
  parent?: string;
  selector?: {
    quote: { exact: string; pre: string; post: string };
    pos: { start: number; end: number };
  };
  resolved?: boolean;
  anchor_lost?: boolean;
}

export interface SearchResultItem {
  id: string;
  title: string;
  type: string;
  project: string;
  tags: string[];
  score: number;
  snippet: string;
  created: string;
  updated: string;
}

export interface ReviewItem {
  reviewer: string;
  status: string;
  completed_at?: string;
  assigned_at: string;
}

export interface ReviewResponse {
  doc: string;
  round: number;
  reviewers: ReviewItem[];
  all_done: boolean;
  deadline?: string;
  notify_on_complete?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  next?: string;
}

export interface TokenShape {
  id: string;
  name: string;
  agent_id: string;
  scopes: string[];
  last_used_at?: string;
  expires_at?: string;
  revoked: boolean;
  created: string;
}
