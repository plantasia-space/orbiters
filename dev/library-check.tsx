import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Slider, Button } from 'plantasia.space-design/react';
// NOTE: once the library ships its CSS (plantasia.space-design wt-3), the real styling import is
// one line: `import 'plantasia.space-design/styles.css'`. Verified working via the library's
// compiled bundle (2026-06-13). The temp dev/_vendor-plantasia-styles.css copy can be deleted.

/**
 * Validation: prove orbiters can CONSUME the shared design library
 * (`plantasia.space-design/react`) — import resolves, components mount, and they're interactive.
 * Styling needs Tailwind v4 + tokens.css in the consumer (added in a follow-up sub-step); this page
 * first confirms functional consumption regardless of styling.
 */
function LibraryCheck() {
  const [val, setVal] = useState(40);
  const [clicks, setClicks] = useState(0);
  return (
    <main style={{ padding: 24, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ fontSize: 18 }}>orbiters · design-library import</h1>
      <p style={{ opacity: 0.8, margin: 0 }}>
        Components imported from <code>plantasia.space-design/react</code>:
      </p>

      <div>
        <div style={{ fontSize: 13, opacity: 0.7 }}>Slider (Radix) — value <code data-testid="slider-value">{val}</code></div>
        <Slider value={[val]} min={0} max={100} step={1} onValueChange={(v) => setVal(v[0])} />
      </div>

      <div>
        <Button onClick={() => setClicks((c) => c + 1)}>Library Button</Button>
        <span style={{ marginLeft: 12, opacity: 0.8 }}>clicked <code data-testid="btn-clicks">{clicks}</code></span>
      </div>
    </main>
  );
}

const el = document.getElementById('library-check-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <LibraryCheck />
    </StrictMode>,
  );
}
