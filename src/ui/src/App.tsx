import React, { useState, useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { Layout } from './components/Layout';
import { DocList } from './components/DocList';
import { DocDetail } from './components/DocDetail';
import { Login } from './components/Login';
import { SearchBar } from './components/SearchBar';
import { apiClient } from './api/client';

function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    apiClient
      .get<{ username: string }>('/auth/me')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  return { authed, setAuthed };
}

function ProtectedRoute({
  children,
  authed,
}: {
  children: React.ReactNode;
  authed: boolean | null;
}) {
  if (authed === null) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        Loading...
      </div>
    );
  }
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { authed, setAuthed } = useAuth();

  return (
    <BrowserRouter basename="/ui">
      <Routes>
        <Route
          path="/login"
          element={
            authed ? (
              <Navigate to="/" replace />
            ) : (
              <Login onSuccess={() => setAuthed(true)} />
            )
          }
        />
        <Route
          path="/*"
          element={
            <ProtectedRoute authed={authed}>
              <Layout onLogout={() => setAuthed(false)}>
                <Routes>
                  <Route path="/" element={<DocList />} />
                  <Route path="/docs/:id" element={<DocDetail />} />
                  <Route path="/search" element={<SearchBar standalone />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
