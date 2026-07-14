/**
 * @file src/input/midi/midiLearnToggle.js
 * @description The one MIDI-learn mode toggle. Lives outside Interaction.js so surfaces
 * that boot with NO voice (the collection studio shell) can wire the M key without pulling
 * the per-voice interaction stack — learn mode itself is voice-independent (the controller
 * is a module singleton). Consumers import this directly; no window global needed.
 */
import { MIDIControllerInstance } from './MIDIController.js';
import { MIDI_SUPPORTED } from '../../config/Constants.js';

let midiToggleInFlight = false;

export async function toggleMidiLearnMode() {
  if (!MIDI_SUPPORTED || !MIDIControllerInstance) {
    console.warn('[MIDI] Toggle requested, but controller is unavailable.');
    return;
  }
  if (midiToggleInFlight) {
    return;
  }
  midiToggleInFlight = true;
  try {
    if (!MIDIControllerInstance.isMIDIActivated) {
      await MIDIControllerInstance.activateMIDI();
      await MIDIControllerInstance.loadPersistedMappings();
    }
    if (MIDIControllerInstance.isMidiLearnModeActive) {
      MIDIControllerInstance.exitMidiLearnMode();
    } else {
      MIDIControllerInstance.enableMidiLearn();
    }
  } catch (error) {
    console.error('[MIDI] Failed to toggle MIDI Learn mode:', error);
  } finally {
    midiToggleInFlight = false;
  }
}
