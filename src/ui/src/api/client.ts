// Typed fetch client for all DocVault API endpoints

const BASE_URL = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    public detail: string
  ) {
    super(detail);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as unknown as T;

  const data = await res.json();

  if (!res.ok) {
    throw new ApiError(
      data.status ?? res.status,
      data.error ?? 'unknown_error',
      data.detail ?? 'Unknown error'
    );
  }

  return data as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// API type definitions
export interface DocListItem {
  id: string;
  title: string;
  type: string;
  project: string;
  tags: string[];
  version: number;
  words: number;
  status: string;
  indexed: boolean;
  created: string;
  updated: string;
  commented?: string | null;
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

export interface CommentSelector {
  quote: { exact: string; pre: string; post: string };
  pos: { start: number; end: number };
}

export interface Comment {
  id: string;
  doc: string;
  author: string;
  type: string;
  body: string;
  round: number;
  created: string;
  updated: string;
  parent?: string;
  selector?: CommentSelector;
  resolved?: boolean;
  anchor_lost?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  project: string;
  tags: string[];
  score: number;
  snippet: string;
  created: string;
  commented?: string | null;
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

export interface VersionSnapshot {
  version:    number;
  title:      string;
  words:      number;
  created_at: string;
  author:     string | null;
  current:    boolean;
}

export interface VersionDetail {
  doc_id:     string;
  version:    number;
  title:      string;
  content:    string;
  words:      number;
  created_at: string;
  author:     string | null;
  html:       string;
}

export interface VersionListResponse {
  data: VersionSnapshot[];
}
