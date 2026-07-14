const INSTANCE_ID_PREFIX = 'orbiters-sensor-instance';

function randomId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 11)}`;
}

export function getLocalSensorInstanceId() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const existing = window.sessionStorage.getItem(INSTANCE_ID_PREFIX);
      if (existing) return existing;
      const created = randomId('lsi');
      window.sessionStorage.setItem(INSTANCE_ID_PREFIX, created);
      return created;
    }
  } catch (_) {
    // Ignore storage access failures.
  }

  return randomId('lsi');
}

export function getLocalSensorSessionKey() {
  if (typeof window === 'undefined') {
    return 'global';
  }

  try {
    const url = new URL(window.location.href);
    const explicit = url.searchParams.get('sensorSession');
    if (explicit) return `sensor:${explicit}`;

    const room = url.searchParams.get('room');
    if (room) return `room:${room}`;

    return `origin:${url.origin}`;
  } catch (_) {
    return 'global';
  }
}

export function getLocalSensorChannelName(sessionKey = getLocalSensorSessionKey()) {
  return `orbiters:sensors:${sessionKey || 'global'}`;
}
