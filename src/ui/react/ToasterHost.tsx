/**
 * @file src/ui/react/ToasterHost.tsx
 * @description Mounts the design-lib `<Toaster>` (sonner) and registers the toast sink so vanilla
 * `AppNotifications.showToast` renders through React (Tier-1 migration). `toast` is imported from the
 * SAME lib entry as `<Toaster>` so both share one sonner instance (a second copy → toasts never show).
 */
import { useEffect } from 'react';
import { Toaster, toast } from 'plantasia.space-design/react';
import { setToastSink, suppressToastKind, type ToastType } from './toastBridge';

const TYPE_FN: Record<ToastType, (msg: string, opts?: Record<string, unknown>) => void> = {
  success: toast.success,
  error: toast.error,
  warning: toast.warning,
  info: toast.info,
};

export function ToasterHost() {
  useEffect(() => {
    setToastSink((message, type, options) => {
      const { duration, kind } = options ?? {};
      (TYPE_FN[type] ?? toast)(message, {
        duration,
        // A DELIBERATE dismiss of a kinded toast mutes that kind for good, so an educational hint shown
        // on every action stops nagging once the user acknowledges it. `onDismiss` fires on an explicit
        // dismiss (close button / swipe; also a programmatic toast.dismiss(), which we don't use on
        // kinded toasts) but NOT on auto-timeout (that's `onAutoClose`) — so letting a toast time out
        // keeps showing it next time.
        onDismiss: kind ? () => suppressToastKind(kind) : undefined,
      });
    });
    return () => setToastSink(null);
  }, []);

  // Orbiters is a dark canvas app; force the dark theme (the lib Toaster defaults to 'system').
  // `closeButton` gives every toast an explicit ✕ on top of swipe-to-dismiss (Bruna).
  return <Toaster theme="dark" closeButton />;
}
