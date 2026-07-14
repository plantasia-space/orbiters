/**
 * Type declarations for the public package entry (`orbiters/multi`). Hand-maintained: the runtime
 * is JSDoc'd JS — keep this surface in sync with src/multi/index.js. Types are deliberately
 * structural and conservative: only what a host needs to compose the realm is named; engine
 * internals stay `unknown`.
 */

/** Ordered voice descriptor (roster entry). The realm resolves the rest from the API. */
export interface VoiceEntry {
  trackId?: string;
  [key: string]: unknown;
}

/** Per-voice handle returned by a session factory. */
export interface VoiceSession {
  voiceId: string;
  start?: () => void | Promise<void>;
  suspend?: () => void;
  resume?: () => void;
  dispose?: () => void;
  [key: string]: unknown;
}

/** Cells the compositor renders into. The host owns the DOM and lends cells to the realm. */
export interface CellSource {
  acquireCell: (index: number, total: number) => HTMLElement | null;
  releaseCell?: (index: number) => void;
}

/** The realm's ONE renderer + canvas + render loop (ViewportCompositor). */
export interface RenderHost {
  renderer: unknown;
  canvas: HTMLCanvasElement;
  createCell: (index: number, total: number) => HTMLElement | null;
  addVoice: (args: { voiceId: string; cell: HTMLElement; controller: unknown }) => void;
  removeVoice: (voiceId: string) => void;
  renderOnce: () => void;
  dispose: () => void;
}

export interface VoiceSessionContext {
  entry: VoiceEntry;
  index: number;
  total: number;
  isPrimary: boolean;
  host: unknown;
  outputNode: unknown;
  renderHost: RenderHost | null;
}

export interface MultiOrbiterApp {
  host: unknown;
  voices: VoiceSession[];
  renderHost: RenderHost | null;
  start: () => Promise<void>;
  dispose: () => void;
  addVoice: (entry: VoiceEntry, index?: number) => Promise<string | null>;
  removeVoice: (voiceId: string) => void;
}

export declare const MAX_CONCURRENT_VOICE_BOOTS: number;
export declare const VOICE_LOAD_TIMEOUT_MS: number;

export declare function createMultiOrbiterApp(opts: {
  roster: VoiceEntry[];
  makeVoiceSession: (ctx: VoiceSessionContext) => VoiceSession | null;
  createHost?: () => unknown;
  createRenderHost?: (() => RenderHost) | null;
  windowTarget?: EventTarget | null;
  documentTarget?: EventTarget | null;
}): MultiOrbiterApp;

export declare function createViewportCompositor(opts?: {
  cellSource?: CellSource | null;
  /** How pixels reach the screen: the displayed fixed canvas (default; full-screen stage layouts)
   *  or a per-cell blit canvas the DOM positions — required under scrolling content, where the
   *  fixed canvas trails the page. */
  presentation?: "fixed-overlay" | "per-cell";
}): RenderHost;

export declare function makeOrbiterVoiceSession(ctx: VoiceSessionContext): VoiceSession | null;

export declare function makeAudioVoiceSession(args: {
  entry: VoiceEntry;
  outputNode: unknown;
  transport?: unknown;
}): VoiceSession;

export declare const voiceRegistry: {
  getActive(): unknown;
  setActive(voiceId: string): void;
  all(): unknown[];
  onActiveChange(listener: (voice: unknown) => void): () => void;
  [key: string]: unknown;
};

export declare function initI18n(): Promise<void>;
