/**
 * @file src/react/engine/EngineContext.tsx
 * @description The React `EngineContext` — the injected engine boundary every
 * orbiters React control reads through (strategy §3).
 *
 * Component code imports `useEngine()` / `useEngineParams()` / `useEngineMidi()`
 * from here and NOTHING else for engine access — no `Main.js`, no `window.*`.
 * The value is built once at the mount boundary by `createEngineContext` and
 * supplied via {@link EngineProvider}.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { EngineContextValue, EngineParams, EngineMidi, EngineDims, EnginePanels, EngineWaveform, EngineWaveformData, EngineTransport, EngineSync, EngineCosmic, EngineSensors, EngineConnection, EngineMonitor, EngineInfo } from './engineTypes';

const EngineContext = createContext<EngineContextValue | null>(null);

export interface EngineProviderProps {
  value: EngineContextValue;
  children: ReactNode;
}

/** Inject the engine boundary at the React root (one per mounted shell). */
export function EngineProvider({ value, children }: EngineProviderProps) {
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

/** The whole engine boundary. Throws if used outside an {@link EngineProvider}. */
export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (ctx === null) {
    throw new Error('useEngine must be used within an <EngineProvider>. The orbiters React UI is a boundary — there is no global engine fallback.');
  }
  return ctx;
}

/** The `params` read-model (ParameterManager facade). */
export function useEngineParams(): EngineParams {
  return useEngine().params;
}

/** The `midi` read-model (MIDIController facade). */
export function useEngineMidi(): EngineMidi {
  return useEngine().midi;
}

/** This UI tree's voice id ('v1'…/orbiter id in multi; null in single-orbiter). Used to scope
 *  per-tile DOM ids (e.g. MIDI-learn target ids) so identical controls across tiles don't collide. */
export function useEngineVoiceId(): string | null {
  return useEngine().voiceId;
}

/** The `dims` read-model (active dimension + switch). */
export function useEngineDims(): EngineDims {
  return useEngine().dims;
}

/** The `panels` read-model (active interaction panel + activate). */
export function useEnginePanels(): EnginePanels {
  return useEngine().panels;
}

/** The `waveform` read-model (Peaks view mount + loop chrome facade). */
export function useEngineWaveform(): EngineWaveform {
  return useEngine().waveform;
}

/** The `waveformData` surface (url/duration/position/seek/loop in seconds) the kit binds to. */
export function useEngineWaveformData(): EngineWaveformData {
  return useEngine().waveformData;
}

/** Nullable read of `waveformData` — returns `null` (rather than throwing) when rendered OUTSIDE an
 *  `<EngineProvider>`. For callers that must degrade gracefully off-engine (e.g. the numeric-keypad
 *  adapter deriving optional grid presets, or a `Parameterized*` control rendered in isolation). */
export function useEngineWaveformDataOptional(): EngineWaveformData | null {
  return useContext(EngineContext)?.waveformData ?? null;
}

/** The `transport` read-model (TransportControl play/stop/toggle facade). */
export function useEngineTransport(): EngineTransport {
  return useEngine().transport;
}

/** The `sync` read-model (tempo-sync engine enable toggle facade). */
export function useEngineSync(): EngineSync {
  return useEngine().sync;
}

/** The `cosmic` read-model (per-axis CosmicLFO enable/source/waveform facade). */
export function useEngineCosmic(): EngineCosmic {
  return useEngine().cosmic;
}

/** The `sensors` read-model (per-axis device-motion enable + calibrate facade). */
export function useEngineSensors(): EngineSensors {
  return useEngine().sensors;
}

/** The `connection` read-model (WebRTC device-pairing state + connect modal facade). */
export function useEngineConnection(): EngineConnection {
  return useEngine().connection;
}

/** The `monitor` read-model (per-dimension audio label+value snapshot facade). */
export function useEngineMonitor(): EngineMonitor {
  return useEngine().monitor;
}

/** The `info` read-model (static track/world/orbiter metadata rows facade). */
export function useEngineInfo(): EngineInfo {
  return useEngine().info;
}
