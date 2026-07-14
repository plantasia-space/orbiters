/**
 * @file src/multi/multiFocusBroadcast.js
 * @description Broadcast policy for multi-focus edits. This is the only layer that knows
 * which per-voice engine actions gang across a selection.
 */
import { voiceRegistry } from '../voice/VoiceRegistry.js';

export const MULTI_FOCUS_WRITE_SOURCE = Object.freeze({ multiFocus: true });

export const BROADCAST_ACTIONS = Object.freeze({
  params: Object.freeze(['setDimensionValue', 'setValue']),
  dims: Object.freeze(['setActive']),
  panels: Object.freeze(['activate']),
  transport: Object.freeze(['play', 'pause', 'stop', 'toggle']),
  waveform: Object.freeze(['setLoopActive']),
  cosmic: Object.freeze(['setEnabled', 'setSource', 'setWaveform', 'triggerKick']),
  // Tempo-sync ENABLE is a per-voice flag (each tile writes its own `syncEnableState`, driving the
  // shared coordinator by the realm aggregate), so ganging it toggles each selected voice's own sync —
  // safe, unlike the realm singletons (sensors/connection) which are absent here on purpose.
  sync: Object.freeze(['setEnabled']),
  // The per-deck launch grid gangs across the selection (decided 2026-07-04): pick a grid with
  // several players focused and they all adopt it. Tempo stays deny-listed below — sharing tempo
  // is what SYNC is for.
  deck: Object.freeze(['setLaunchGridBars']),
});

export const PARAM_DENYLIST = new Set([
  // Decided with multi-focus: tempo / deck clock controls are per-deck and NEVER gang. Sharing tempo
  // is what SYNC is for — a gang-edit writing every selected deck's clock would be a second,
  // ungated sync path.
  'sync-bpm',
  'sync-track-bpm',
]);

export function isGangableParam(name) {
  return typeof name === 'string' && !PARAM_DENYLIST.has(name);
}

export function isBroadcastAction(facade, method) {
  return BROADCAST_ACTIONS[facade]?.includes(method) === true;
}

export function multiFocusActive(voiceId) {
  return (
    voiceId != null &&
    voiceRegistry.selectionSize > 1 &&
    voiceRegistry.isSelected(voiceId)
  );
}

function siblingArgs(facade, method, args) {
  if (facade !== 'params') return args;
  if (!isGangableParam(args[0])) return null;
  if (method === 'setDimensionValue') {
    return [args[0], args[1], args[2], MULTI_FOCUS_WRITE_SOURCE, args[4], args[5]];
  }
  if (method === 'setValue') {
    return [args[0], args[1], MULTI_FOCUS_WRITE_SOURCE, args[3], args[4]];
  }
  return args;
}

export function broadcastAction(voiceId, facade, method, args) {
  if (!isBroadcastAction(facade, method) || !multiFocusActive(voiceId)) return;
  const replayArgs = siblingArgs(facade, method, args);
  if (!replayArgs) return;
  for (const targetId of voiceRegistry.getSelection()) {
    if (targetId === voiceId) continue;
    const action = voiceRegistry.get(targetId)?.engineCommands?.[facade]?.[method];
    if (typeof action !== 'function') continue;
    try {
      action(...replayArgs);
    } catch (error) {
      console.warn('[multiFocusBroadcast] sibling action failed', { targetId, facade, method, error });
    }
  }
}
