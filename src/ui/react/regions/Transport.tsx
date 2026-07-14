/**
 * @file src/ui/react/regions/Transport.tsx
 * @description The transport region (strategy §5) — play / stop / record / loop.
 *
 * Bruna's mockup (2026-06-17): the transport moved to the HEADER CENTRE (replacing the
 * removed title), rendered as a HORIZONTAL row of icons (play / stop / record / loop).
 *
 * Buttons are the lib `CornerButton` (icon-only, no label) — the SAME primitive the sensor
 * calibrate/connect buttons use, so the transport matches the rest of the header chrome
 * (Bruna 2026-06-20): play/stop/record are `kick` (momentary, bracket-flash), loop is `toggle`.
 *
 * Wiring:
 *   - play  → `transport.toggle()` (play↔pause), icon swaps from the transport subscription so it
 *     tracks playback regardless of what changed it.
 *   - stop  → `transport.stop()`.
 *   - record → opens the CaptureDialog (capture-format picker → openCaptureWindow).
 *   - loop  → the `waveform` surface (`setLoopActive`), the SAME owner the Playback LOOP button drives.
 *   - MIDI: play/stop = GLOBAL momentary triggers (`play-toggle`/`stop`); loop = the GLOBAL latching
 *     toggle (`loop-toggle`). The learn DOM attrs ride on each button via `{...midiProps}`.
 */
import { useCallback, useEffect, useState } from 'react';
import { CornerButton } from 'plantasia.space-design/react';
import { Icon } from 'plantasia.space-design/icons';
import { useTrigger, useToggle } from '../../../react/parameters';
import { useEngine, useEngineTransport, useEngineWaveform } from '../../../react/engine/EngineContext';
import type { TransportState, TransportCountIn } from '../../../react/engine/engineTypes';
import { openCaptureDialog } from './captureDialogStore';
import { captureControl } from '../../../export/capture.js';
import { isMobileDevice } from '../../../config/Constants.js';
import { getT } from '../../../i18n/index.js';

export function Transport() {
  const { voiceId } = useEngine();
  const transport = useEngineTransport();
  const waveform = useEngineWaveform();
  const t = getT();
  // Screen-capture support is static per browser (it gates on `getDisplayMedia`). Hide RECORD when
  // unsupported (e.g. iOS Safari) — parity with the legacy transport, which hid the record item when
  // `captureControl.isSupported()` was false rather than showing a button that can't work.
  // Record is a DESKTOP screen-capture affordance: also hide it on mobile devices (Android exposes
  // `getDisplayMedia`, so the capability check alone would surface a phone-hostile control) and reclaim
  // its slot in the compressed mobile header. Mirrors the device-based sensor gating (Constants).
  const captureSupported = captureControl.isSupported() && !isMobileDevice();

  // Playback state → the play button shows play↔pause (legacy play-toggle), driven by the
  // surface's window-event subscription so it tracks any source (this button, MIDI, keyboard, EOT).
  const [state, setState] = useState<TransportState>(() => transport.getState());
  useEffect(() => {
    setState(transport.getState());
    return transport.subscribe(setState);
  }, [transport]);
  const isPlaying = state === 'playing';

  // First-gesture hint — pulse the Play button in the success ink (the design-lib
  // `ps-attention` breathe) while the orbiter is freshly opened and playback hasn't begun, so the
  // user knows pressing Play is the first move. Latches off the moment playback starts (and never
  // re-blinks this session), so a later pause doesn't re-trigger the attention state.
  const [hasPlayed, setHasPlayed] = useState(false);
  useEffect(() => {
    if (isPlaying && !hasPlayed) setHasPlayed(true);
  }, [isPlaying, hasPlayed]);
  const hintPlay = !isPlaying && !hasPlayed;

  // Loop on/off — durable across the lazy waveform view (keys on the `ui:loop-toggle` event), the
  // same loop owner the Playback LOOP button drives. `subscribeLoopActive` emits the current state
  // immediately, so the toggle reflects the real loop state — loop-on by default — from
  // interface load, before the waveform view is built.
  const [loopOn, setLoopOn] = useState<boolean>(() => waveform.getLoopActive());
  useEffect(() => {
    return waveform.subscribeLoopActive(setLoopOn);
  }, [waveform]);
  const onLoop = useCallback(
    (pressed: boolean) => {
      waveform.setLoopActive(pressed);
      setLoopOn(pressed);
    },
    [waveform],
  );

  // Quantized-start count-in. When Play is pressed on a shared clock, playback waits for the
  // next launch-grid bar; without a cue the UI looks frozen (Bruna hit exactly this). Subscribe to the
  // count-in and show a beat countdown under the play button while armed. Initial read covers a mount
  // mid-wait; the window event tracks arm/clear thereafter.
  const [countIn, setCountIn] = useState<TransportCountIn>(() => transport.getCountIn());
  useEffect(() => {
    setCountIn(transport.getCountIn());
    return transport.subscribeCountIn(setCountIn);
  }, [transport]);
  // Beats remaining until the bar — ticked ONE render per beat (a self-rescheduling timeout to the
  // next integer boundary, not a per-frame rAF), so the countdown stays cheap on mobile. 0 = inactive.
  const [beatsLeft, setBeatsLeft] = useState(0);
  useEffect(() => {
    const { active, targetTime, bpm } = countIn;
    if (!active || !targetTime || !bpm || bpm <= 0) {
      setBeatsLeft(0);
      return;
    }
    const msPerBeat = 60000 / bpm;
    let timer = 0;
    const tick = () => {
      const remainMs = targetTime - performance.now();
      if (remainMs <= 0) {
        setBeatsLeft(0); // the bar is here; the clear event flips `active` off
        return;
      }
      const beats = Math.ceil(remainMs / msPerBeat);
      setBeatsLeft(beats);
      // Sleep until this count crosses into the next-lower integer (one render per beat).
      const nextMs = remainMs - (beats - 1) * msPerBeat;
      timer = window.setTimeout(tick, Math.max(16, nextMs));
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [countIn]);
  const counting = countIn.active && beatsLeft > 0;

  // MIDI-learn targets: play/stop are GLOBAL momentary triggers under the legacy flat keys (the
  // learn target is the always-visible button); loop is the GLOBAL latching toggle.
  const playMidi = useTrigger({ componentId: 'play-toggle', scope: 'GLOBAL', onTrigger: () => transport.toggle() });
  const stopMidi = useTrigger({ componentId: 'stop', scope: 'GLOBAL', onTrigger: () => transport.stop() });
  const { midiProps: loopMidiProps } = useToggle({ componentId: 'loop-toggle', scope: 'GLOBAL', value: loopOn, onToggle: onLoop });

  return (
    <div className="orbiters-react-ui__transport" data-ui-interactive data-ui-react-region="transport">
      <span className="orbiters-react-ui__play-wrap">
        <CornerButton
          kind="kick"
          className={`orbiters-react-ui__header-corner-btn${hintPlay ? ' ps-attention' : ''}`}
          // The custom `--attention` var via a computed string key (the same pattern as
          // SensorConnectionButton's `--corner-active`), NOT `as CSSProperties` — the cast resolved to
          // the app's React.CSSProperties, which lacks the custom-property index signature the lib's
          // CornerButton style prop expects (dual @types/react under the live-linked design-lib).
          style={hintPlay ? { ['--attention' as string]: 'var(--success)' } : undefined}
          icon={<Icon name={isPlaying ? 'pause' : 'play'} />}
          aria-label={isPlaying ? t('transport.pause') : t('transport.play')}
          title={isPlaying ? t('transport.pause') : t('transport.play')}
          {...playMidi.midiProps}
          onClick={() => transport.toggle()}
        />
        {/* Count-in under the play button — the wait to the next launch bar. `aria-live` so a
            screen reader announces "armed"; `aria-hidden` number is decorative (the live region speaks). */}
        {counting && (
          <span
            className="orbiters-react-ui__count-in"
            role="status"
            aria-live="polite"
            aria-label={t('transport.countIn', { beats: beatsLeft })}
          >
            <span aria-hidden="true">{beatsLeft}</span>
          </span>
        )}
      </span>
      <CornerButton
        kind="kick"
        className="orbiters-react-ui__header-corner-btn"
        icon={<Icon name="stop" />}
        aria-label={t('transport.stop')}
        title={t('transport.stop')}
        {...stopMidi.midiProps}
        onClick={() => transport.stop()}
      />
      {captureSupported && (
        <CornerButton
          kind="kick"
          className="orbiters-react-ui__header-corner-btn"
          icon={<Icon name="video" />}
          aria-label={t('capture.recordCta')}
          title={t('capture.recordCtaTitle')}
          // Record opens the capture-format dialog (CaptureDialog); the dialog's CTA is the user
          // gesture that opens the capture window (so window.open isn't pop-up-blocked).
          onClick={() => openCaptureDialog(voiceId)}
        />
      )}
      <CornerButton
        kind="toggle"
        className="orbiters-react-ui__header-corner-btn"
        pressed={loopOn}
        onPressedChange={onLoop}
        icon={<Icon name="loop-2" />}
        aria-label={t('topBar.loopLabel')}
        title={t('topBar.loopLabel')}
        {...loopMidiProps}
      />
    </div>
  );
}
