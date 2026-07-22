/**
 * @file src/ui/react/regions/CaptureDialog.tsx
 * @description The RECORD flow — the capture-format picker dialog (ported from the legacy
 * `ButtonGroup.showCapturePresetModal`). Opened by the Transport RECORD button via
 * `captureDialogStore`; the user picks a fixed aspect ratio (persisted) then clicks "Record in a new
 * window", which opens the capture window (`openCaptureWindow`) — the SAME capture engine the legacy
 * flow used. Recording starts ONLY from the CTA (a user gesture, so `window.open` isn't blocked),
 * never as a side effect of selecting an aspect.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  FourCornerCard,
} from 'plantasia.space-design/react';
import { useEngine } from '../../../react/engine/EngineContext';
import { useEngineSubscription, type EngineSubscribable } from '../../../react/engine/useEngineSubscription';
import { voiceRegistry } from '../../../voice/VoiceRegistry.js';
import {
  CAPTURE_ASPECTS,
  getCaptureAspect,
  setCaptureAspect,
} from '../../../export/captureSettings.js';
import { openCaptureWindow } from '../../../export/captureWindow.js';
import notifications from '../../../core/AppNotifications.js';
import { getT } from '../../../i18n/index.js';
import { isCaptureDialogOpen, closeCaptureDialog, subscribeCaptureDialog, getCaptureDialogVoiceId } from './captureDialogStore';
import { usePortalContainer } from '../PortalContainerProvider';

/** Stable identity for `useEngineSubscription` (re-render the dialog on open/close). */
const CAPTURE_DIALOG_SUBSCRIBABLE: EngineSubscribable = { subscribe: subscribeCaptureDialog };

const PREVIEW_MAX_PX = 34;

export function CaptureDialog() {
  useEngineSubscription(CAPTURE_DIALOG_SUBSCRIBABLE);
  const { voiceId } = useEngine();
  const portalContainer = usePortalContainer();
  // Every tile mounts a CaptureDialog, but capture is single-focus. Only the dialog whose
  // voice OPENED the record flow renders, so one RECORD click no longer pops all N dialogs at once.
  // (null === null for single-orbiter, so its one dialog always matches.)
  const open = isCaptureDialogOpen() && getCaptureDialogVoiceId() === voiceId;
  const t = getT();

  const [selected, setSelected] = useState<string>(() => getCaptureAspect());

  const onRecord = () => {
    // Recording opens a separate window; quiet the WHOLE source realm here so the user focuses on what's
    // being recorded rather than every other stage/feed-card still sounding in their ears (product call:
    // pause all, not just the one whose RECORD was pressed — applies to a collection AND the shared feed
    // realm where several cards can play at once). Single-orbiter = the one voice, byte-identical. Pause
    // only a voice that is actually playing, so a stopped stage isn't flipped into a spurious paused state.
    for (const voice of voiceRegistry.all()) {
      const tc = voice?.transportControl;
      if (tc?.isPlaying?.()) tc.pause?.();
    }
    // Synchronous within the click handler → keeps the user gesture so `window.open` isn't blocked.
    // Pass this dialog's voice so an embedded host (feed realm) can target the right track.
    const captureWindow = openCaptureWindow(selected, { voiceId });
    if (!captureWindow) {
      notifications.showToast(t('capture.windowBlocked'), 'warning', 4000);
    }
    closeCaptureDialog();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeCaptureDialog();
      }}
    >
      <DialogContent className="orbiters-capture-dialog" data-ui-interactive container={portalContainer ?? undefined}>
        <DialogHeader>
          <DialogTitle>{t('capture.presetTitle')}</DialogTitle>
        </DialogHeader>
        <p className="orbiters-capture-dialog__description">{t('capture.presetDescription')}</p>
        <div
          className="orbiters-capture-dialog__options"
          role="radiogroup"
          aria-label={t('capture.presetTitle')}
        >
          {CAPTURE_ASPECTS.map((format) => {
            const active = format.id === selected;
            const w = Number(format.width) || 1;
            const h = Number(format.height) || 1;
            const previewW = w >= h ? PREVIEW_MAX_PX : Math.max(12, (w / h) * PREVIEW_MAX_PX);
            const previewH = h >= w ? PREVIEW_MAX_PX : Math.max(12, (h / w) * PREVIEW_MAX_PX);
            return (
              <button
                key={format.id}
                type="button"
                role="radio"
                aria-checked={active}
                className="orbiters-capture-dialog__option"
                data-active={active || undefined}
                onClick={() => setSelected(setCaptureAspect(format.id))}
              >
                {/* Brand corner-bracket card: success-green corners when selected, the neutral
                    border token otherwise (FourCornerCard from the design kit). */}
                <FourCornerCard
                  cornerColors={active ? 'var(--success)' : 'var(--color-border)'}
                  className="orbiters-capture-dialog__option-card"
                  contentClassName="orbiters-capture-dialog__option-content"
                  // The corner colour is the "this format is selected" signal, so it has to be
                  // readable at rest rather than only while the pointer is over the option.
                  alwaysShowCorners
                >
                  <span className="orbiters-capture-dialog__option-preview-row" aria-hidden="true">
                    <span
                      className="orbiters-capture-dialog__option-preview"
                      style={{ width: `${Math.round(previewW)}px`, height: `${Math.round(previewH)}px` }}
                    />
                  </span>
                  <span className="orbiters-capture-dialog__option-title">{format.id}</span>
                  <span className="orbiters-capture-dialog__option-meta">{`${format.width}×${format.height}`}</span>
                </FourCornerCard>
              </button>
            );
          })}
        </div>
        <div className="orbiters-capture-dialog__footer">
          <Button variant="ghost" onClick={() => closeCaptureDialog()}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="successOutlined"
            onClick={onRecord}
            title={t('capture.recordCtaTitle')}
            aria-label={t('capture.recordCtaTitle')}
          >
            <span className="orbiters-capture-dialog__rec-dot" aria-hidden="true" />
            {t('capture.recordCta')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
