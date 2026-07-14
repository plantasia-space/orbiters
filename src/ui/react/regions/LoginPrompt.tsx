/**
 * @file src/ui/react/regions/LoginPrompt.tsx
 * @description React login nudge (Tier-1 migration). Replaces the body-appended, hand-positioned link
 * `loginPrompt.js` built (with its own resize/orientation listeners). Driven imperatively by the
 * auth/settings/MIDI flows through `loginPromptBridge`; rendered inline in the HeaderBar (no JS layout).
 * Renders null until a flow triggers it (logged-out) and the shell registers the sink.
 */
import { useEffect, useState } from 'react';
import { setLoginPromptSink, type LoginPromptRequest } from '../loginPromptBridge';

export function LoginPrompt() {
  const [req, setReq] = useState<LoginPromptRequest | null>(null);

  useEffect(() => {
    setLoginPromptSink({ show: setReq, hide: () => setReq(null) });
    return () => setLoginPromptSink(null);
  }, []);

  if (!req) return null;

  return (
    <a
      className="orbiters-react-ui__login"
      href={req.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={req.ariaLabel}
    >
      {req.text}
    </a>
  );
}
