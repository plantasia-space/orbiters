/**
 * Determines whether we currently have any MIDI outputs that are connected/open.
 * @param {import('./MidiConnectionManager.js').MidiConnectionManager} connectionManager
 * @returns {boolean}
 */
export function hasConnectedMidiOutputs(connectionManager) {
  if (!connectionManager || typeof connectionManager.getConnectedOutputs !== 'function') {
    return false;
  }
  const outputs = connectionManager.getConnectedOutputs() || [];
  if (!outputs.length) {
    return false;
  }
  return outputs.some((port) => {
    const state = typeof port?.state === 'string' ? port.state.toLowerCase() : '';
    const connection = typeof port?.connection === 'string' ? port.connection.toLowerCase() : '';
    return state === 'connected' || connection === 'open' || connection === 'connected';
  });
}

/**
 * Determines whether any MIDI mappings are active for widgets/parameters.
 * @param {import('./MidiMappingRegistry.js').MidiMappingRegistry} mappingRegistry
 * @param {Map} widgetMappings
 * @param {Map} paramMappings
 * @returns {boolean}
 */
export function hasActiveMidiMappings(mappingRegistry, widgetMappings, paramMappings) {
  if (!mappingRegistry) {
    return false;
  }
  if (typeof mappingRegistry.hasParameterMappings === 'function') {
    if (mappingRegistry.hasParameterMappings()) {
      return true;
    }
  } else if (mappingRegistry.parameterMappings?.size) {
    return true;
  }
  return Boolean(
    (widgetMappings && widgetMappings.size > 0) || (paramMappings && paramMappings.size > 0),
  );
}
