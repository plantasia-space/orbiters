// main.ts — the minimal, non-React UI for the clock kill-gate harness.
//
// It builds a tiny DOM (no framework, no design-lib), wires the buttons to a ClockKillgate instance,
// and reads snapshots on a single rAF. The Connect WS URL comes from VITE_WS_CONNECT (same var the
// product uses), with the prod default as a fallback; the session id comes from ?session=… so two
// machines join the SAME session by sharing the URL.
//
// Open this page on two machines/browsers with the same ?session=… and press Start on both.

import { ClockKillgate, type KillgateExport } from './ClockKillgate';

// Vite injects import.meta.env; read it defensively so the harness still typechecks/runs without it.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const WS_URL: string = env?.VITE_WS_CONNECT ?? 'wss://connect.plantasia.space/ws/';

function sessionIdFromUrl(): string {
  try {
    return new URL(window.location.href).searchParams.get('session') || 'orb118-killgate';
  } catch {
    return 'orb118-killgate';
  }
}

function boolFlagFromUrl(name: string): boolean {
  try {
    const v = (new URL(window.location.href).searchParams.get(name) || '').trim().toLowerCase();
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

function numFromUrl(name: string, dflt: number): number {
  try {
    const v = new URL(window.location.href).searchParams.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  } catch {
    return dflt;
  }
}

const OFFSET_RANGE_MS = 500; // covers integrated-speaker + Bluetooth latencies

const sessionId = sessionIdFromUrl();
// ?latencyComp=1 starts the gate with output-latency compensation ON; it is also toggleable
// live via the checkbox below so a single session can record A (off) then B (on) for comparison.
const latencyComp = boolFlagFromUrl('latencyComp');
// Manual calibration: ?audioOffset=NN ms pre-loads this device's offset (bookmark it per device
// once dialed in). Covers output latency the browser under-reports (e.g. iOS ~12.6 ms vs ~125 ms real).
const initialOffsetMs = numFromUrl('audioOffset', 0);
const gate = new ClockKillgate({ wsUrl: WS_URL, sessionId, latencyComp });
gate.setManualOffsetMs(initialOffsetMs);

// ---- DOM scaffolding (kept inline so the harness is one self-contained module) ------------
const app = document.getElementById('app') ?? document.body;
app.innerHTML = `
  <h1>Clock kill-gate</h1>
  <p class="muted">
    Open this page on TWO machines/browsers with the SAME <code>?session=</code>, press <b>Start audio</b>
    on each, then <b>Record 60s</b>. Compare the exported JSON offline. This page logs SCHEDULING-side
    data; true acoustic steadiness needs a manual mic recording of the speaker.
  </p>
  <div class="row">
    <span class="badge">WS: <code id="wsUrl"></code></span>
    <span class="badge">session: <code id="sessionId"></code></span>
    <span class="badge">peer: <code id="peerId"></code></span>
  </div>

  <table class="readout">
    <tr><td>audio</td><td id="r-audio">stopped</td></tr>
    <tr><td>peers (this session)</td><td id="r-peers">0</td></tr>
    <tr><td>serverNow offset</td><td id="r-offset">— ms</td></tr>
    <tr><td>½ RTT (est.)</td><td id="r-rtt">— ms</td></tr>
    <tr><td>tempo (shared)</td><td id="r-bpm">— bpm</td></tr>
    <tr><td>beat · phase</td><td id="r-beat">—</td></tr>
    <tr><td>transport</td><td id="r-play">stopped</td></tr>
    <tr><td>clicks scheduled · cancelled</td><td id="r-clicks">0 · 0</td></tr>
    <tr><td>latency comp</td><td id="r-latcomp">off</td></tr>
    <tr><td>manual offset · total comp</td><td id="r-mancomp">0 ms · 0 ms</td></tr>
    <tr><td>recording</td><td id="r-rec">idle</td></tr>
  </table>

  <div class="row">
    <button id="b-start">Start audio</button>
    <button id="b-play" disabled>Play (bar-quantized)</button>
    <button id="b-stop" disabled>Stop</button>
  </div>
  <div class="row">
    <label>Propose tempo
      <input id="i-bpm" type="number" min="20" max="300" value="120" />
    </label>
    <button id="b-tempo">Set</button>
  </div>
  <div class="row">
    <label><input id="c-latcomp" type="checkbox" /> Output-latency comp (A/B)</label>
  </div>
  <div class="row">
    <label>Manual audio offset (ms)
      <input id="i-offset" type="range" min="-500" max="500" step="1" value="0" />
    </label>
    <input id="n-offset" type="number" min="-500" max="500" step="1" value="0" style="width:5em" />
    <span class="muted">fires this device's clicks earlier — dial until two devices line up acoustically</span>
  </div>
  <div class="row">
    <button id="b-record" disabled>Record 60s</button>
    <button id="b-export" disabled>Export JSON</button>
    <span id="r-exportNote" class="muted"></span>
  </div>
`;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

($('wsUrl') as HTMLElement).textContent = WS_URL;
($('sessionId') as HTMLElement).textContent = sessionId;

// Open the Connect socket immediately so offset/peers are live before audio starts.
gate.connect();
// The header label starts as connecting and is updated live in the rAF loop (see frame()).
($('peerId') as HTMLElement).textContent = '(connecting…)';

const bStart = $('b-start') as HTMLButtonElement;
const bPlay = $('b-play') as HTMLButtonElement;
const bStop = $('b-stop') as HTMLButtonElement;
const bTempo = $('b-tempo') as HTMLButtonElement;
const bRecord = $('b-record') as HTMLButtonElement;
const bExport = $('b-export') as HTMLButtonElement;
const iBpm = $('i-bpm') as HTMLInputElement;
const cLatComp = $('c-latcomp') as HTMLInputElement;
const iOffset = $('i-offset') as HTMLInputElement;
const nOffset = $('n-offset') as HTMLInputElement;

// Reflect the initial flag state and let the operator toggle comp live (A/B).
cLatComp.checked = latencyComp;
cLatComp.addEventListener('change', () => gate.setLatencyComp(cLatComp.checked));

// Manual calibration: keep the slider + number box in sync and push to the gate live.
function applyOffset(v: number): void {
  const ms = Math.max(-OFFSET_RANGE_MS, Math.min(OFFSET_RANGE_MS, Math.round(v) || 0));
  iOffset.value = String(ms);
  nOffset.value = String(ms);
  gate.setManualOffsetMs(ms);
}
iOffset.addEventListener('input', () => applyOffset(Number(iOffset.value)));
nOffset.addEventListener('change', () => applyOffset(Number(nOffset.value)));
applyOffset(initialOffsetMs);

bStart.addEventListener('click', () => {
  void gate.start().then(() => {
    bStart.disabled = true;
    bStart.textContent = 'audio running';
    bPlay.disabled = false;
    bStop.disabled = false;
    bRecord.disabled = false;
  });
});

bPlay.addEventListener('click', () => gate.play());
bStop.addEventListener('click', () => gate.stop());
bTempo.addEventListener('click', () => gate.setTempo(Number(iBpm.value) || 120));

bRecord.addEventListener('click', () => {
  gate.startRecording();
});

bExport.addEventListener('click', () => {
  const data = gate.getLastExport();
  if (!data) return;
  downloadJson(data);
});

function downloadJson(data: KillgateExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `orb118-killgate-${data.meta.peerId}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- single rAF read loop -----------------------------------------------------------------
function fmtMs(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} ms`;
}

let lastRecording = false;
function frame(): void {
  const s = gate.snapshot();
  ($('r-audio') as HTMLElement).textContent = s.audioRunning ? 'running' : 'stopped';
  // Header peer label reflects live connection state: connecting → connected → N peer(s).
  ($('peerId') as HTMLElement).textContent =
    s.peerCount > 0
      ? `connected · ${s.peerCount} peer${s.peerCount === 1 ? '' : 's'}`
      : s.joined
        ? 'connected · waiting for a peer'
        : '(connecting…)';
  ($('r-peers') as HTMLElement).textContent = String(s.peerCount);
  ($('r-offset') as HTMLElement).textContent = fmtMs(s.offsetMs);
  ($('r-rtt') as HTMLElement).textContent = `${s.halfRttMs.toFixed(1)} ms`;
  ($('r-bpm') as HTMLElement).textContent = `${s.bpm.toFixed(1)} bpm`;
  ($('r-beat') as HTMLElement).textContent = `beat ${s.beatNow.toFixed(2)} · phase ${s.phaseNow.toFixed(2)}/${s.quantum}`;
  ($('r-play') as HTMLElement).textContent = s.playing
    ? s.countInBeats && s.countInBeats > 0
      ? `count-in… ${s.countInBeats.toFixed(1)} beats`
      : 'playing ▶'
    : 'stopped ■';
  ($('r-clicks') as HTMLElement).textContent = `${s.scheduledCount} · ${s.cancelledCount}`;
  ($('r-latcomp') as HTMLElement).textContent = s.latencyComp
    ? `on · −${s.latencyCompMs.toFixed(1)} ms`
    : 'off';
  ($('r-mancomp') as HTMLElement).textContent =
    `${s.manualOffsetMs.toFixed(0)} ms · −${s.totalCompMs.toFixed(1)} ms`;
  ($('r-rec') as HTMLElement).textContent = s.recording
    ? `recording… ${(s.recordRemainingMs / 1000).toFixed(0)}s left`
    : 'idle';

  bRecord.disabled = !s.audioRunning || s.recording;

  // When a recording finishes, enable export.
  if (lastRecording && !s.recording) {
    bExport.disabled = gate.getLastExport() == null;
    ($('r-exportNote') as HTMLElement).textContent = gate.getLastExport()
      ? '← 60s capture ready to export'
      : '';
  }
  lastRecording = s.recording;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => gate.dispose());

// Expose for console inspection during the gate run.
(window as unknown as { __killgate: ClockKillgate }).__killgate = gate;
