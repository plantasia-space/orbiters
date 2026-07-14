import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Foundation proof: a trivial React island rendered by Vite + @vitejs/plugin-react
 * inside the orbiters Vite app. Confirms TS/TSX compiles, React 19 mounts, and state/events
 * work — with zero coupling to Main.js. Dev-only; not shipped, not part of the app boot.
 */
function FoundationCheck() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ padding: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: 20 }}>orbiters · React foundation ✓</h1>
      <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
        React 19 + TypeScript are rendering inside the orbiters Vite build. Vanilla and React
        islands coexist; React only owns migrated surfaces.
      </p>
      <button
        data-testid="foundation-counter"
        onClick={() => setCount((c) => c + 1)}
        style={{
          padding: '8px 16px', fontSize: 16, cursor: 'pointer',
          background: '#1e1e28', color: '#eee', border: '1px solid #444', borderRadius: 6,
        }}
      >
        clicked {count} time{count === 1 ? '' : 's'}
      </button>
    </main>
  );
}

const el = document.getElementById('react-foundation-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <FoundationCheck />
    </StrictMode>,
  );
}
