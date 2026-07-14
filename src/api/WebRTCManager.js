/**
 * @file src/api/WebRTCManager.js
 * @description Orchestrates WebSocket signalling, WebRTC peer connections, and the
 * bridge that streams external sensor data into the Orbiters engine/UI.
 */

import { UNIQUE_ID, isMobileDevice } from '../config/Constants.js';
import notifications from '../core/AppNotifications.js';
import { SensorController } from '../input/SensorsController.js'; // Import the class
import { AVAILABLE_EFFECT_DEFINITIONS } from '../audio/effects/index.js';
import { getT } from '../i18n/index.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { LocalSensorRegistry } from '../sensors/LocalSensorRegistry.js';
import { LocalSensorBridge } from '../sensors/LocalSensorBridge.js';

const LOCAL_SENSOR_HEARTBEAT_MS = 1000;

// `qrcode` (~15-20 kB gzip) is only needed for the sensor-pairing QR. Import it on demand and cache
// the module promise so it stays out of the eager main bundle.
let _qrcodeModulePromise = null;
function loadQRCode() {
    _qrcodeModulePromise ??= import('qrcode')
        .then((mod) => mod.default ?? mod)
        .catch((err) => {
            // Don't cache a failed chunk fetch (offline blip / stale hashed chunk during a rollout) —
            // clear it so the next pairing attempt retries, matching the old always-present static import.
            _qrcodeModulePromise = null;
            throw err;
        });
    return _qrcodeModulePromise;
}

function createLocalSourceId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `lss-${crypto.randomUUID()}`;
    }
    return `lss-${Math.random().toString(36).slice(2, 11)}`;
}

// The mobile sensor client offers up to four orbiter slots. Slot ↔ orbiter follows the DESKTOP
// stage order (`voiceRegistry.getSlotOrder()`) so slot B on the phone is the orbiter labelled B on the
// desktop; only when the layout is not slotted (e.g. `?multi` grid) does it fall back to registration
// order (`voiceRegistry.all()`). The phone echoes voice ids on select, so the mapping is id-exact.
const ORBITER_SLOT_LETTERS = ['A', 'B', 'C', 'D'];

/**
 * Assign each live orbiter voice a UNIQUE A/B/C/D slot index. Voices present in the desktop
 * stage `order` take their stage index (so the phone's letters match the desktop's); the rest fill the
 * remaining free slots in registration order. Never drops a live voice — a momentarily stale/empty
 * `order` (e.g. mid-reconcile) just falls back to registration order, so the picker never vanishes.
 * @param {string[]} voiceIds live registered voice ids, registration order
 * @param {Array<string|null>|null|undefined} order stage index → voiceId (may be stale/partial/null)
 * @returns {Array<{ id: string, slotIndex: number }>} one entry per voice (capped at 4), unique slotIndex
 */
export function assignOrbiterSlots(voiceIds, order) {
    const ids = (Array.isArray(voiceIds) ? voiceIds : []).slice(0, ORBITER_SLOT_LETTERS.length);
    const orderable = Array.isArray(order) && order.length > 0;
    const slotIndex = new Array(ids.length).fill(null);
    const used = new Set();
    if (orderable) {
        ids.forEach((id, listIndex) => {
            const stageIndex = order.indexOf(id);
            if (stageIndex >= 0 && stageIndex < ORBITER_SLOT_LETTERS.length && !used.has(stageIndex)) {
                slotIndex[listIndex] = stageIndex;
                used.add(stageIndex);
            }
        });
    }
    let nextFree = 0;
    ids.forEach((id, listIndex) => {
        if (slotIndex[listIndex] != null) return;
        while (used.has(nextFree)) nextFree += 1;
        slotIndex[listIndex] = nextFree;
        used.add(nextFree);
    });
    return ids.map((id, listIndex) => ({ id, slotIndex: slotIndex[listIndex] }));
}

/**
 * Resolve the Connect service endpoints (pairing base URL + signaling WebSocket) for the CURRENT
 * environment. Standalone (Vite) inlines `VITE_CONNECT_URL` / `VITE_WS_CONNECT` at build. But the feed
 * realm imports this engine into root's WEBPACK build, which does NOT process `import.meta.env` — there it
 * would silently fall back to the prod default, so a DEV feed paired a phone against the PROD mobile
 * client. Mirroring `Constants.ROOT_BASE`: read the Vite env, else a host-injected `window.VITE_CONNECT_URL`
 * global, else DERIVE dev-vs-prod from root's injected `window.ORBITER_APP_URL` (or the current host) so a
 * dev host targets `dev-connect`. Prod is the safe default (only a clear `dev` host marker flips it).
 */
export function resolveConnectEndpoints() {
    const fromEnv = (key) => {
        try {
            return import.meta.env?.[key] || undefined;
        } catch (_error) {
            return undefined;
        }
    };
    const fromWindow = (key) => (typeof window !== 'undefined' ? window[key] : undefined) || undefined;

    let baseUrl = fromEnv('VITE_CONNECT_URL') || fromWindow('VITE_CONNECT_URL');
    let wsUrl = fromEnv('VITE_WS_CONNECT') || fromWindow('VITE_WS_CONNECT');
    if (baseUrl && wsUrl) {
        return { baseUrl, wsUrl };
    }

    // Host-embedded with no injected connect URL → derive the environment from a reliably-present host.
    const hosts = [];
    if (typeof window !== 'undefined') {
        try {
            if (window.ORBITER_APP_URL) hosts.push(new URL(window.ORBITER_APP_URL).hostname);
        } catch (_error) { /* ORBITER_APP_URL not a parseable URL — skip */ }
        if (window.location?.hostname) hosts.push(window.location.hostname);
    }
    const isDev = hosts.some(
        (host) => /(^|[.-])dev([.-]|$)/.test(host) || host.includes('localhost') || host.includes('127.0.0.1'),
    );
    const sub = isDev ? 'dev-connect' : 'connect';
    return {
        baseUrl: baseUrl || `https://${sub}.plantasia.space/`,
        wsUrl: wsUrl || `wss://${sub}.plantasia.space/ws/`,
    };
}

/**
 * @class WebRTCManager
 * @description Handles WebSocket signaling, WebRTC connections, DataChannel communication, and external sensor integration.
 */
export class WebRTCManager {
    // Private static instance variable
    static #instance = null;
    static #noopInstance = null;

    // Backing field for the `isConnected` accessor. Initialised here (before the constructor body)
    // so the constructor's `this.isConnected = false` is a same-value no-op and does NOT dispatch a
    // spurious `orbiters:connection-changed` at construction time.
    _connectedState = false;

    /**
     * Returns the singleton instance of WebRTCManager.
     * @param {Function} onSensorData - Callback function to handle incoming sensor data.
     * @returns {WebRTCManager} The singleton instance.
     */
    static getInstance(onSensorData) {
        if (isMobileDevice()) {
            if (!WebRTCManager.#noopInstance) {
                WebRTCManager.#noopInstance = {
                    initialize: async () => {},
                    generateConnectionModal: () => {},
                    generateDisconnectionModal: () => {},
                    cleanupConnection: () => {},
                    sendDimensionsList: () => {},
                    sendDimensionActive: () => {},
                    sendFullToggleState: () => {},
                    sendToggleSnapshotForDimension: () => {},
                };
            }
            return WebRTCManager.#noopInstance;
        }

        if (!WebRTCManager.#instance) {
            WebRTCManager.#instance = new WebRTCManager(onSensorData);
        }
        return WebRTCManager.#instance;
    }

    /**
     * Returns the existing desktop instance without creating one (null before init, or on mobile
     * where getInstance returns the noop). The React `connection` surface reads it — it
     * must NOT create the manager, which needs an `onSensorData` callback PanelManager owns.
     * @returns {WebRTCManager|null}
     */
    static getExistingInstance() {
        return WebRTCManager.#instance;
    }

    /**
     * Live-connection state. Backed by an accessor so EVERY transition (data-channel open/close,
     * cleanup, ICE failure) dispatches `orbiters:connection-changed` — the React `connection`
     * surface keys on it. This event IS the connection-status signal: the old legacy
     * connect-button DOM (since removed) refreshed itself imperatively and left a React mirror
     * with nothing to observe.
     */
    get isConnected() {
        return this._connectedState ?? false;
    }

    set isConnected(value) {
        const next = Boolean(value);
        if (this._connectedState === next) return;
        this._connectedState = next;
        if (typeof document !== 'undefined') {
            document.dispatchEvent(
                new CustomEvent('orbiters:connection-changed', { detail: { connected: next } }),
            );
        }
    }

    /**
     * Private constructor to prevent direct instantiation.
     * @param {Function} onSensorData - Callback function to handle incoming sensor data.
     */
    constructor(onSensorData) {
        if (WebRTCManager.#instance) {
            throw new Error('Use WebRTCManager.getInstance() to get the singleton instance.');
        }

        // Basic properties
        this.ws = null;                // WebSocket instance
        this.peerConnection = null;    // Peer-to-peer RTCPeerConnection
        this.dataChannel = null;       // DataChannel for communication
        this.targetClientId = null;    // Mobile clientId to target for signaling
        this.clientId = null;          // This desktop's own clientId
        this.isConnected = false;      // Tracks if we have a live connection

        // We have removed the custom ping/pong to rely on ICE + DataChannel detection
        // So we do not keep pingInterval or pingTimeout for the disconnection logic

        // onSensorData callback if needed
        this.onSensorData = onSensorData;

        // Tracks if the standard “Connect External Sensor” modal has been shown once
        this.modalGenerated = false;

        // Possibly track if we have explicitly disconnected
        this.disconnectedMode = false;

        this.handleSensorToggleEvent = this.handleSensorToggleEvent.bind(this);
        this.handleDimensionChanged = this.handleDimensionChanged.bind(this);

        this.localSensorMode = 'none';
        this.localSourceId = null;
        this.localOwnerInstanceId = null;
        this.localSensorRegistry = null;
        this.localSensorBridge = null;
        this.localSensorHeartbeatId = null;
        this.localSharedUnsubscribe = null;
        this.localSharedControlUnsubscribe = null;
        this.localRegistryUnsubscribe = null;
        this.localSharedSourceMeta = null;
        this.suppressNextWsCloseHandling = false;
        this.disableAutomaticSignalingReconnect = false;

        this.isDisconnectionModalVisible = false;

        this.registerToggleSync();
        this.registerDimensionSync();
        this.initializeLocalSensorSharing();
        this.initializeSignalingServer();

        // Keep the mobile client's A/B/C/D orbiter slots in sync as orbiters open/close or the
        // selection changes. Coalesced to ONE send per tick, so a multi-slot select (which fires several
        // registry notifications — setActive then addToSelection) publishes only the FINAL roster, not
        // intermediate states the phone would flicker through. No-ops when no DataChannel is open, so
        // subscribing here (before any connection) is safe. The phone maps its slot taps back via
        // `orbiters:select`.
        // True when the phone has deselected ALL A/B/C/D slots ("drive none") — incoming sensor
        // frames are then dropped and the roster reports an empty `active`, without touching desktop focus.
        this._sensorSuspended = false;
        this._orbitersListSyncScheduled = false;
        this._orbitersSyncUnsubs = [
            voiceRegistry.onVoicesChange?.(() => this.scheduleOrbitersListSync()),
            voiceRegistry.onActiveChange?.(() => this.scheduleOrbitersListSync()),
            voiceRegistry.onSelectionChange?.(() => this.scheduleOrbitersListSync()),
        ].filter(Boolean);
    }

    /**
     * Maintained for backward compatibility with callers expecting an async initializer.
     * All necessary setup runs in the constructor, so this simply resolves immediately.
     * @returns {Promise<void>}
     */
    async initialize() {
        return;
    }

    initializeLocalSensorSharing() {
        this.localSensorRegistry = new LocalSensorRegistry();
        this.localSensorRegistry.connect();
        this.localRegistryUnsubscribe = this.localSensorRegistry.onSourcesChanged((sources) => {
            this.handleLocalSourcesChanged(sources);
        });

        this.localSensorBridge = new LocalSensorBridge({
            instanceId: this.localSensorRegistry.instanceId,
            sessionKey: this.localSensorRegistry.sessionKey,
        });
        this.localSensorBridge.connect();
    }

    handleLocalSourcesChanged(sources = []) {
        if (this.localSensorMode !== 'shared-consumer' || !this.localSourceId) {
            return;
        }

        const matchingSource = sources.find((source) => source.sourceId === this.localSourceId) || null;
        const stillAvailable = Boolean(matchingSource);
        if (stillAvailable) {
            this.localSharedSourceMeta = matchingSource;
            return;
        }

        this.disconnectSharedLocalSource({ showReconnect: false });
        this.disconnectedMode = true;
        this.isDisconnectionModalVisible = false;
        notifications.showToast(getT()('notifications.mobileDeviceDisconnected'), 'warning');
    }

    /**
     * Initializes the WebSocket to the signaling server & handles main events.
     */
    initializeSignalingServer() {
        const clientType = isMobileDevice() ? 'mobile' : 'desktop'; // Check device type

        if (isMobileDevice()) {
            // Mobile device detected. External connection is not needed.
            return; // Do nothing for mobile, no external sensor needed
        }

        const { wsUrl } = resolveConnectEndpoints();
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            // Connected to WebSocket server.
            this.ws.send(JSON.stringify({ type: 'register', clientType, uniqueId: UNIQUE_ID }));
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);

                switch (message.type) {
                    case 'registered':
                        this.clientId = message.clientId;
                        if (clientType === 'desktop') {
                            if (this.disconnectedMode) {
                                // Show disconnection modal if flagged as disconnected
                                this.generateDisconnectionModal();
                            } else {
                                this.generateConnectionModal();
                            }
                        }
                        break;

                    case 'mobileConnected':
                        this.targetClientId = message.clientId;
                        this.createAndSendOffer();
                        break;

                    case 'mobileDisconnected':
                        this.cleanupConnection();
                        this.isConnected = false;
                        this.disconnectedMode = true;
                        notifications.showToast(getT()('notifications.mobileDeviceDisconnected'), 'warning');
                        this.generateDisconnectionModal();
                        break;

                    case 'answer':
                        if (this.peerConnection) {
                            this.peerConnection.setRemoteDescription(
                                new RTCSessionDescription(message.answer)
                            ).then(() => {
                                // Remote description set successfully.
                            }).catch(err => {
                                console.error('[WebRTCManager] Error setting remote description:', err);
                            });
                        } else {
                            console.error('[WebRTCManager] PeerConnection not initialized.');
                        }
                        break;

                    case 'candidate':
                        if (this.peerConnection) {
                            this.peerConnection.addIceCandidate(
                                new RTCIceCandidate(message.candidate)
                            ).then(() => {
                                // ICE Candidate added successfully.
                            }).catch(err => {
                                console.error('[WebRTCManager] Error adding ICE Candidate:', err);
                            });
                        } else {
                            console.error('[WebRTCManager] PeerConnection not initialized.');
                        }
                        break;

                    case 'pong':
                        // Pong received from mobile.
                        break;

                    case 'error':
                        console.error(`[WebRTCManager] Server Error: ${message.message}`);
                        if (message.message.includes('Another instance has connected')) {
                            // Treat like a forced disconnection
                            this.disableAutomaticSignalingReconnect = true;
                            this.cleanupConnection();
                            this.isConnected = false;
                            this.disconnectedMode = true;
                            notifications.showToast(getT()('notifications.connectionLostAnotherInstance'), 'error');
                            this.generateDisconnectionModal();
                        }
                        break;

                    case 'toggle':
                        if (this.isMessageTargetedToDesktop(message)) {
                            this.handleToggleMessage(message);
                        }
                        break;

                    case 'toggle:get':
                        if (this.isMessageTargetedToDesktop(message)) {
                            const requesterId = message.clientId || message.sourceClientId || this.targetClientId;
                            this.sendFullToggleState(requesterId);
                        }
                        break;

                    case 'toggle:state':
                        // Received toggle state message (ignored on desktop)
                        break;

                    default:
                        // Unknown message type
                }
            } catch (error) {
                console.error('[WebRTCManager] Error parsing WebSocket message:', event.data, error);
            }
        };

        // If the WS closes unexpectedly, treat it like a disconnection
        this.ws.onclose = () => {
            if (this.suppressNextWsCloseHandling) {
                this.suppressNextWsCloseHandling = false;
                return;
            }
            if (this.isConnected) {
                this.cleanupConnection();
                this.isConnected = false;
                this.disconnectedMode = true;
                notifications.showToast('Connection lost.', 'warning');
                this.generateDisconnectionModal();
            }
            if (!this.disableAutomaticSignalingReconnect) {
                this.reconnectSignalingServer();
            }
        };

        this.ws.onerror = (error) => {
            console.error('[WebRTCManager] WebSocket error:', error);
        };
    }

    /**
     * If you want to show sensor toggles or connect external sensors, use this.
     * (Retained from your original code.)
     */
    async manageSensors() {
        const t = getT();
        if (this.useInternalSensors && SensorController.isSupported()) {
            const permissionGranted = await this.requestPermission();
            if (permissionGranted) {
                await this.activateSensors();
                // Internal sensor activation is silent (no success toast) — it is automatic,
                // not a user action. Errors below still surface.
            } else {
                notifications.showToast(t('notifications.sensorPermissionDenied'), 'error');
            }
        } else if (this.useExternalSensors) {
            const webRTCManager = WebRTCManager.getInstance();
            // webRTCManager.generateConnectionModal();
        } else {
            notifications.showToast(t('notifications.noSensorsAvailable'), 'warning');
        }
    }

    /**
     * Publish the pairing-modal view state for the React `SensorPairingDialog`. The manager keeps
     * owning the decision (which view, re-entrancy flags) and React only renders. Returns true when
     * handled (always, outside SSR) — React is the only UI.
     */
    _emitReactPairingModal({ view, reconnect = false, sources = [] }) {
        if (typeof document === 'undefined') {
            return false;
        }
        document.dispatchEvent(new CustomEvent('orbiters:sensor-pairing', {
            detail: {
                open: true,
                view,
                reconnect: Boolean(reconnect),
                pairingInfo: this.buildPairingInfo(),
                sources: Array.isArray(sources) ? sources : [],
            },
        }));
        return true;
    }

    /** Choice view → "connect a new device": resume direct signalling + switch to the QR view. */
    requestDirectConnection(reconnect = false) {
        this.disableAutomaticSignalingReconnect = false;
        this.transitionToDirectConnectionQrModal(reconnect);
    }

    /** The React dialog was dismissed: clear the re-entrancy flag so a later drop can re-open it. */
    notifyPairingClosed() {
        this.isDisconnectionModalVisible = false;
    }

    /**
     * Shows the "Connect External Sensor" modal with a QR code.
     */
    generateConnectionModal(force = false) {
        if (this.isConnected) {
            return;
        }
        if (!force && this.modalGenerated) {
            return;
        }

        if (!this.clientId) {
            setTimeout(() => this.generateConnectionModal(force), 500);
            return;
        }
        if (!force) {
            this.modalGenerated = true;
        }

        const availableLocalSources = this.localSensorRegistry?.getAvailableSources?.() || [];
        if (this._emitReactPairingModal({
            view: availableLocalSources.length > 0 ? 'choice' : 'qr',
            reconnect: false,
            sources: availableLocalSources,
        })) {
            return;
        }
        if (availableLocalSources.length > 0) {
            this.showLocalSensorChoiceModal(availableLocalSources);
            return;
        }

        const pairingInfo = this.buildPairingInfo();
        

        loadQRCode().then((QRCode) => QRCode.toDataURL(pairingInfo, { width: 150 }))
            .then((url) => {
                const t = getT();
                const description = t('sensors.modal.connectDescription');
                const manualEntry = t('sensors.modal.manualEntry');
                const modalContent = `
                  <div style="text-align: center; padding: 15px;">
                    <p style="margin-bottom: 10px;">${description}</p>
                    <img src="${url}" alt="QR Code" style="display: block; margin: 0 auto; max-width: 150px; height: auto;" />
                    <p style="margin-top: 10px; font-size: 12px; word-break: break-word; color: #555;">
                      ${manualEntry}<br />
                      <a href="${pairingInfo}" target="_blank" style="color: #007bff;">${pairingInfo}</a>
                    </p>
                  </div>
                `;
                notifications
                    .showUniversalModal(t('sensors.modal.connectTitle'), modalContent, t('common.close'))
                    .then(() => {
                        // Modal closed.
                    });
            })
            .catch((error) => {
                console.error('[WebRTCManager] Error generating QR code:', error);
                notifications.showToast(getT()('notifications.qrGenerationError'), 'error');
            });
    }

    /**
     * Shows the "Reconnect External Sensor" modal with different text.
     */
    generateDisconnectionModal() {
        if (this.isConnected) {
            return;
        }
        if (this.isDisconnectionModalVisible) {
            return;
        }

        

        if (!this.clientId) {
            setTimeout(() => this.generateDisconnectionModal(), 500);
            return;
        }

        const availableLocalSources = this.localSensorRegistry?.getAvailableSources?.() || [];
        if (this._emitReactPairingModal({
            view: availableLocalSources.length > 0 ? 'choice' : 'qr',
            reconnect: true,
            sources: availableLocalSources,
        })) {
            this.isDisconnectionModalVisible = true;
            return;
        }

        notifications.closeModal();

        if (availableLocalSources.length > 0) {
            this.showLocalSensorChoiceModal(availableLocalSources, { reconnect: true });
            return;
        }

        const pairingInfo = this.buildPairingInfo();


        loadQRCode().then((QRCode) => QRCode.toDataURL(pairingInfo, { width: 150 }))
            .then((url) => {
                const t = getT();
                const heading = t('sensors.modal.disconnectedHeading');
                const description = t('sensors.modal.disconnectedDescription');
                const manualEntry = t('sensors.modal.manualEntry');
                const modalContent = `
                  <div style="text-align: center; padding: 15px;">
                    <p style="margin-bottom: 10px; font-weight: bold;">${heading}</p>
                    <p style="margin-bottom: 10px;">
                      ${description}
                    </p>
                    <img src="${url}" alt="QR Code" style="display: block; margin: 0 auto; max-width: 150px; height: auto;" />
                    <p style="margin-top: 10px; font-size: 12px; word-break: break-word; color: #555;">
                      ${manualEntry}<br>
                      <a href="${pairingInfo}" target="_blank" style="color: #007bff;">${pairingInfo}</a>
                    </p>
                  </div>
                `;

                notifications
                    .showUniversalModal(t('sensors.modal.reconnectTitle'), modalContent, t('common.close'))
                    .then(() => {
                        this.isDisconnectionModalVisible = false;
                    });
                this.isDisconnectionModalVisible = true;
            })
            .catch((error) => {
                console.error('[WebRTCManager] Error generating disconnection QR code:', error);
                notifications.showToast('Error generating disconnection QR code.', 'error');
            });
    }

    showLocalSensorChoiceModal(sources = [], { reconnect = false } = {}) {
        const primarySource = sources[0] || null;
        if (!primarySource) {
            return;
        }

        if (this._emitReactPairingModal({ view: 'choice', reconnect, sources })) {
            this.isDisconnectionModalVisible = reconnect;
            return;
        }

        const t = getT();
        const container = document.createElement('div');
        container.style.display = 'grid';
        container.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
        container.style.gap = '16px';
        container.style.padding = '8px 4px';

        const createColumn = ({ title, description, accent, onClick, diagramSrc, diagramAlt }) => {
            const card = document.createElement('div');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', title);
            card.style.border = `1px solid ${accent}`;
            card.style.borderRadius = '12px';
            card.style.padding = '16px';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.gap = '10px';
            card.style.minHeight = '160px';
            card.style.background = '#fff';
            card.style.cursor = 'pointer';
            card.style.transition = 'transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease';

            const activate = () => {
                onClick?.();
            };

            card.addEventListener('click', activate);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
            card.addEventListener('mouseenter', () => {
                card.style.transform = 'translateY(-1px)';
                card.style.boxShadow = `0 10px 24px ${accent}22`;
            });
            card.addEventListener('mouseleave', () => {
                card.style.transform = 'translateY(0)';
                card.style.boxShadow = 'none';
            });
            card.addEventListener('focus', () => {
                card.style.transform = 'translateY(-1px)';
                card.style.boxShadow = `0 0 0 3px ${accent}33`;
            });
            card.addEventListener('blur', () => {
                card.style.transform = 'translateY(0)';
                card.style.boxShadow = 'none';
            });

            const heading = document.createElement('div');
            heading.style.fontWeight = '700';
            heading.style.fontSize = '16px';
            heading.textContent = title;

            const body = document.createElement('p');
            body.style.margin = '0';
            body.style.fontSize = '14px';
            body.style.lineHeight = '1.4';
            body.textContent = description;

            const diagram = document.createElement('img');
            diagram.src = diagramSrc;
            diagram.alt = diagramAlt;
            diagram.loading = 'lazy';
            diagram.decoding = 'async';
            diagram.style.display = 'block';
            diagram.style.width = '100%';
            diagram.style.maxWidth = '220px';
            diagram.style.height = 'auto';
            diagram.style.margin = '6px auto 0';
            diagram.style.borderRadius = '8px';

            card.appendChild(heading);
            card.appendChild(body);
            card.appendChild(diagram);
            return card;
        };

        container.appendChild(createColumn({
            title: t('sensors.modal.sharedChoice.useConnected.title'),
            description: t('sensors.modal.sharedChoice.useConnected.description'),
            accent: '#4CAF50',
            diagramSrc: 'https://plantasia-prod-public.fra1.digitaloceanspaces.com/assets/symbols/current/orbiters/option-A.png',
            diagramAlt: 'Option A diagram',
            onClick: () => {
                this.connectToSharedLocalSource(primarySource);
                notifications.closeModal();
            },
        }));

        container.appendChild(createColumn({
            title: t('sensors.modal.sharedChoice.connectNew.title'),
            description: t('sensors.modal.sharedChoice.connectNew.description'),
            accent: '#007bff',
            diagramSrc: 'https://plantasia-prod-public.fra1.digitaloceanspaces.com/assets/symbols/current/orbiters/option-B.png',
            diagramAlt: 'Option B diagram',
            onClick: () => {
                this.disableAutomaticSignalingReconnect = false;
                this.transitionToDirectConnectionQrModal(reconnect);
            },
        }));

        this.isDisconnectionModalVisible = reconnect;
        notifications.showUniversalModal(
            reconnect ? t('sensors.modal.reconnectTitle') : t('sensors.modal.connectTitle'),
            container,
            t('common.close')
        ).then(() => {
            this.isDisconnectionModalVisible = false;
        });
    }

    showDirectConnectionQrModal(reconnect = false) {
        if (reconnect) {
            this.generateDisconnectionModalQrOnly();
            return;
        }
        this.generateConnectionModalQrOnly();
    }

    transitionToDirectConnectionQrModal(reconnect = false) {
        // React owns the dialog — switching choice→QR is just a view change, no DOM hidden-event dance.
        if (this._emitReactPairingModal({ view: 'qr', reconnect })) {
            this.isDisconnectionModalVisible = reconnect;
            return;
        }
        const modalElement = document.getElementById('universalModal');
        if (!modalElement) {
            this.showDirectConnectionQrModal(reconnect);
            return;
        }

        const handleHidden = () => {
            modalElement.removeEventListener('hidden.ui-core.modal', handleHidden);
            this.showDirectConnectionQrModal(reconnect);
        };

        modalElement.addEventListener('hidden.ui-core.modal', handleHidden, { once: true });
        notifications.closeModal();
    }

    generateConnectionModalQrOnly() {
        if (this._emitReactPairingModal({ view: 'qr', reconnect: false })) {
            return;
        }
        const pairingInfo = this.buildPairingInfo();

        loadQRCode().then((QRCode) => QRCode.toDataURL(pairingInfo, { width: 150 }))
            .then((url) => {
                const t = getT();
                const description = t('sensors.modal.connectDescription');
                const manualEntry = t('sensors.modal.manualEntry');
                const modalContent = `
                  <div style="text-align: center; padding: 15px;">
                    <p style="margin-bottom: 10px;">${description}</p>
                    <img src="${url}" alt="QR Code" style="display: block; margin: 0 auto; max-width: 150px; height: auto;" />
                    <p style="margin-top: 10px; font-size: 12px; word-break: break-word; color: #555;">
                      ${manualEntry}<br />
                      <a href="${pairingInfo}" target="_blank" style="color: #007bff;">${pairingInfo}</a>
                    </p>
                  </div>
                `;
                notifications.showUniversalModal(t('sensors.modal.connectTitle'), modalContent, t('common.close'));
            })
            .catch((error) => {
                console.error('[WebRTCManager] Error generating QR code:', error);
                notifications.showToast(getT()('notifications.qrGenerationError'), 'error');
            });
    }

    generateDisconnectionModalQrOnly() {
        if (this._emitReactPairingModal({ view: 'qr', reconnect: true })) {
            this.isDisconnectionModalVisible = true;
            return;
        }
        const pairingInfo = this.buildPairingInfo();

        loadQRCode().then((QRCode) => QRCode.toDataURL(pairingInfo, { width: 150 }))
            .then((url) => {
                const t = getT();
                const heading = t('sensors.modal.disconnectedHeading');
                const description = t('sensors.modal.disconnectedDescription');
                const manualEntry = t('sensors.modal.manualEntry');
                const modalContent = `
                  <div style="text-align: center; padding: 15px;">
                    <p style="margin-bottom: 10px; font-weight: bold;">${heading}</p>
                    <p style="margin-bottom: 10px;">
                      ${description}
                    </p>
                    <img src="${url}" alt="QR Code" style="display: block; margin: 0 auto; max-width: 150px; height: auto;" />
                    <p style="margin-top: 10px; font-size: 12px; word-break: break-word; color: #555;">
                      ${manualEntry}<br>
                      <a href="${pairingInfo}" target="_blank" style="color: #007bff;">${pairingInfo}</a>
                    </p>
                  </div>
                `;

                notifications.showUniversalModal(t('sensors.modal.reconnectTitle'), modalContent, t('common.close'))
                    .then(() => {
                        this.isDisconnectionModalVisible = false;
                    });
                this.isDisconnectionModalVisible = true;
            })
            .catch((error) => {
                console.error('[WebRTCManager] Error generating disconnection QR code:', error);
                notifications.showToast('Error generating disconnection QR code.', 'error');
            });
    }

    /**
     * The "Connect/Disconnect" button event: always shows connection modal for user to re-initiate.
     */
    handleConnectionButtonClick() {
        
        // Opening the chooser/modal must stay passive. Only an explicit
        // "connect new device" action should resume direct signaling ownership.
        this.disconnectedMode = false;
        this.generateConnectionModal(true);
    }

    /**
     * Creates a RTCPeerConnection and sends an offer to the mobile.
     */
    createAndSendOffer() {
        if (!this.targetClientId) {
            return;
        }
        if (this.peerConnection) {
            return;
        }

        this.peerConnection = new RTCPeerConnection();

        // 1) ICE candidates
        this.peerConnection.onicecandidate = (e) => {
            if (e.candidate) {
                this.ws.send(JSON.stringify({
                    type: 'candidate',
                    candidate: e.candidate,
                    targetClientId: this.targetClientId
                }));
            }
        };

        // 2) ICE connection state: if we get disconnected/failed, we do immediate cleanup
        this.peerConnection.oniceconnectionstatechange = () => {
            const state = this.peerConnection.iceConnectionState;
            if (state === 'disconnected' || state === 'failed') {
                this.cleanupConnection();
                this.disconnectedMode = true;
                notifications.showToast('Connection lost.', 'warning');
                this.generateDisconnectionModal();
            }
        };

        // 3) Create DataChannel
        this.dataChannel = this.peerConnection.createDataChannel('sensorData');

        // 4) DataChannel event handling
        this.dataChannel.onopen = () => {
            this.isConnected = true;
            this.clearAutomaticTakeoverState();
            this.disconnectedMode = false;
            notifications.closeModal();
            this.isDisconnectionModalVisible = false;
            this.startOwnedLocalSensorSource();
            this.sendWelcomeMessage();
            this.sendDimensionsList();
            this.sendDimensionActive(this.getActiveDimensionId());
            // Send initial toggle snapshot over DataChannel
            this.sendFullToggleStateDC();
            // A fresh pairing starts DRIVING (the focused orbiter), never stuck in a prior
            // "all off" state; then send the initial A/B/C/D roster so the phone renders its selector.
            this._sensorSuspended = false;
            this.sendOrbitersList();
        };
        this.dataChannel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleDataChannelMessage(message);
            } catch (err) {
                console.error('[WebRTCManager][DC RX] JSON parse error:', err, 'payload:', event.data);
            }
        };
        this.dataChannel.onerror = (error) => {
            console.error('[WebRTCManager] DataChannel error:', error);
        };
        this.dataChannel.onclose = () => {
            this.cleanupConnection();
            this.disconnectedMode = true;
            notifications.showToast('Connection lost.', 'warning');
            this.generateDisconnectionModal();
        };

        // 5) Create SDP Offer
        this.peerConnection.createOffer()
            .then((offer) => this.peerConnection.setLocalDescription(offer))
            .then(() => {
                this.ws.send(JSON.stringify({
                    type: 'offer',
                    offer: this.peerConnection.localDescription,
                    targetClientId: this.targetClientId
                }));
            })
            .catch((error) => console.error('[WebRTCManager] Error creating SDP offer:', error));
    }

    /**
     * DataChannel message parsing: sensorData, ack, etc.
     */
    handleDataChannelMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }

        switch (message.type) {
            case 'sensorData':
                this.processExternalSensorData(message.payload, message.dimension);
                break;
            case 'dimensions:get':
                this.sendDimensionsList();
                break;
            case 'dimension:set':
                this.handleDimensionSet(message);
                this.publishLocalControlMessage(message);
                break;
            case 'dimension:active':
                this.publishLocalControlMessage(message);
                break;
            case 'pong':
            case 'ack':
                // Handshake/keepalive responses - nothing required.
                break;
            case 'toggle':
                this.handleToggleMessage(message);
                this.publishLocalControlMessage(message);
                break;
            case 'toggle:get':
                this.sendFullToggleStateDC();
                break;
            case 'toggle:state':
                this.applyToggleStateSnapshot(message.states, message.dimension);
                this.publishLocalControlMessage(message);
                break;
            case 'orbiters:get':
                this.sendOrbitersList();
                break;
            case 'orbiters:select':
                this.handleOrbitersSelect(message);
                break;
            default:
                // Unknown message type
        }
    }

    /**
     * For passing sensor data to your SensorController if needed.
     */
    processExternalSensorData(payload, dimensionId = null) {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        // The phone turned all A/B/C/D slots off → drive nothing (drop the incoming frames).
        if (this._sensorSuspended) {
            return;
        }
        const { alpha, beta, gamma } = payload;
        const sensorData = {
            alpha: typeof alpha === 'number' ? alpha : 0,
            beta: typeof beta === 'number' ? beta : 0,
            gamma: typeof gamma === 'number' ? gamma : 0
        };
        try {
            const sensorController = SensorController.getExistingInstance();
            if (!sensorController) {
                console.warn('[WebRTCManager] SensorController not initialized; dropping external sensor data.');
                return;
            }
            sensorController.setExternalSensorData(sensorData, dimensionId);
            if (this.localSensorMode === 'owned-direct' && this.localSourceId) {
                this.localSensorBridge?.publishFrame(this.localSourceId, sensorData);
            }
        } catch (error) {
            console.error('[WebRTCManager] Failed to update SensorController:', error.message);
        }
    }

    /**
     * If the server forcibly closes or we want to attempt a new connection.
     */
    reconnectSignalingServer() {
        setTimeout(() => {
            this.initializeSignalingServer();
        }, 5000);
    }

    /**
     * Optionally send a welcome message on the data channel, if needed.
     */
    sendWelcomeMessage() {
        const welcomeMessage = { type: 'welcome', message: 'Hello Mobile! Connection established.' };
        this.sendMessageOverDataChannel(welcomeMessage);
    }

    /**
     * Test function to send data if needed.
     */
    sendSensorDataToMobile(data) {
        this.sendMessageOverDataChannel({ type: 'sensorData', payload: data });
    }

    /**
     * Example testing method
     */
    sendTestData() {
        const testData = { test: 'Test message from desktop to mobile.', timestamp: Date.now() };
        this.sendSensorDataToMobile(testData);
    }

    /**
     * Cleans up the existing WebRTC connection, DataChannel, etc.
     */
    cleanupConnection() {
        this.disconnectSharedLocalSource({ showReconnect: false });
        this.stopOwnedLocalSensorSource();
        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.oniceconnectionstatechange = null;
            this.peerConnection.close();
            this.peerConnection = null;
        }
        if (this.dataChannel) {
            this.dataChannel.onopen = null;
            this.dataChannel.onmessage = null;
            this.dataChannel.onerror = null;
            this.dataChannel.onclose = null;
            this.dataChannel.close();
            this.dataChannel = null;
        }
        this.targetClientId = null;
        this.isConnected = false;
        this.modalGenerated = false;
    }

    startOwnedLocalSensorSource() {
        if (!this.localSensorRegistry || !this.localSensorBridge) {
            return;
        }

        if (!this.localSourceId) {
            this.localSourceId = createLocalSourceId();
        }

        this.localSensorMode = 'owned-direct';
        this.localOwnerInstanceId = this.localSensorRegistry.instanceId;
        this.localSensorRegistry.publishOwnerConnected({
            sourceId: this.localSourceId,
            connectedAt: Date.now(),
            label: 'Mobile sensor',
            pairingInfo: this.buildPairingInfo(),
        });

        if (this.localSensorHeartbeatId) {
            clearInterval(this.localSensorHeartbeatId);
        }
        this.localSensorHeartbeatId = setInterval(() => {
            this.localSensorRegistry?.publishHeartbeat(this.localSourceId);
        }, LOCAL_SENSOR_HEARTBEAT_MS);
    }

    stopOwnedLocalSensorSource() {
        if (this.localSensorHeartbeatId) {
            clearInterval(this.localSensorHeartbeatId);
            this.localSensorHeartbeatId = null;
        }

        if (this.localSensorMode === 'owned-direct' && this.localSourceId) {
            this.localSensorRegistry?.publishOwnerDisconnected(this.localSourceId);
        }

        if (this.localSensorMode === 'owned-direct') {
            this.localSensorMode = 'none';
            this.localOwnerInstanceId = null;
            this.localSourceId = null;
        }
    }

    connectToSharedLocalSource(source) {
        const sourceId = typeof source === 'string' ? source : source?.sourceId;
        if (!sourceId || !this.localSensorBridge) {
            return;
        }

        if (this.localSharedUnsubscribe) {
            this.localSharedUnsubscribe();
            this.localSharedUnsubscribe = null;
        }
        if (this.localSharedControlUnsubscribe) {
            this.localSharedControlUnsubscribe();
            this.localSharedControlUnsubscribe = null;
        }

        this.localSharedUnsubscribe = this.localSensorBridge.subscribe(sourceId, (payload) => {
            this.processExternalSensorData(payload);
        });
        this.localSharedControlUnsubscribe = this.localSensorBridge.subscribeControls(sourceId, (message) => {
            this.applyLocalSharedControlMessage(message);
        });
        this.localSensorMode = 'shared-consumer';
        this.localSourceId = sourceId;
        this.localOwnerInstanceId = typeof source === 'object' ? source?.ownerInstanceId ?? null : null;
        this.localSharedSourceMeta = typeof source === 'object' ? { ...source } : { sourceId };
        this.isConnected = true;
        this.disconnectedMode = false;
        this.isDisconnectionModalVisible = false;
        notifications.closeModal();
    }

    disconnectSharedLocalSource({ showReconnect = false } = {}) {
        if (this.localSharedUnsubscribe) {
            this.localSharedUnsubscribe();
            this.localSharedUnsubscribe = null;
        }
        if (this.localSharedControlUnsubscribe) {
            this.localSharedControlUnsubscribe();
            this.localSharedControlUnsubscribe = null;
        }

        const wasSharedConsumer = this.localSensorMode === 'shared-consumer';
        if (wasSharedConsumer) {
            this.localSensorMode = 'none';
            this.localSourceId = null;
            this.localOwnerInstanceId = null;
            this.localSharedSourceMeta = null;
            this.isConnected = false;
            if (showReconnect) {
                this.disconnectedMode = true;
                this.generateDisconnectionModal();
            }
        }
    }

    publishLocalControlMessage(message) {
        if (this.localSensorMode !== 'owned-direct' || !this.localSourceId || !message) {
            return;
        }

        const supportedTypes = new Set(['dimension:set', 'dimension:active', 'toggle', 'toggle:state']);
        if (!supportedTypes.has(message.type)) {
            return;
        }

        this.localSensorBridge?.publishControl(this.localSourceId, message);
    }

    applyLocalSharedControlMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }

        switch (message.type) {
            case 'dimension:set':
            case 'dimension:active':
                this.handleDimensionSet(message);
                break;
            case 'toggle':
                this.handleToggleMessage(message);
                break;
            case 'toggle:state':
                this.applyToggleStateSnapshot(message.states, message.dimension);
                break;
            default:
                break;
        }
    }

    attemptSharedSourceTakeover(pairingInfo) {
        return false;
    }

    clearAutomaticTakeoverState() {
        return;
    }

    buildPairingInfo() {
        const { baseUrl, wsUrl } = resolveConnectEndpoints();
        const uniqueId = UNIQUE_ID;
        return `${baseUrl}?uniqueId=${uniqueId}&wsUrl=${encodeURIComponent(wsUrl)}`;
    }

    /**
     * Registers listeners to mirror local sensor toggle changes to connected mobile clients.
     */
    registerToggleSync() {
        document.addEventListener('sensorToggleChanged', this.handleSensorToggleEvent);
    }

    registerDimensionSync() {
        document.addEventListener('orbiters:dimension-changed', this.handleDimensionChanged);
    }

    /**
     * Handles toggle events emitted by the SensorController.
     * @param {CustomEvent} event - The dispatched toggle event.
     */
    handleSensorToggleEvent(event) {
        const detail = event?.detail;
        if (!detail) {
            return;
        }
        const { key, value, source, dimension } = detail;
        if (source === 'remote') {
            return; // Prevent echoing remote updates back to mobile.
        }
        this.sendToggleUpdate(key, value, dimension);
    }

    handleDimensionChanged(event) {
        const nextDimension = event?.detail?.dimensionId ?? event?.detail?.activeDimensionId ?? this.getActiveDimensionId();
        if (!nextDimension) {
            return;
        }
        this.sendDimensionActive(nextDimension);
        this.sendToggleSnapshotForDimension(nextDimension);
    }

    /**
     * Sends a single toggle update to the connected mobile client.
     * @param {string} key - The toggle identifier ('sX', 'sY', 'sZ').
     * @param {boolean} value - The toggle state.
     */
    sendToggleUpdate(key, value, dimension = null) {
        const resolvedDimension = dimension ?? this.getActiveDimensionId() ?? 'default';
        const payload = { type: 'toggle', key, value: !!value };
        if (resolvedDimension) {
            payload.dimension = resolvedDimension;
        }

        if (!this.sendMessageOverDataChannel(payload)) {
            // DataChannel not open; toggle update dropped.
        }
    }

    // Helpers for DC toggle sync
    isDataChannelOpen() {
        return !!(this.dataChannel && this.dataChannel.readyState === 'open');
    }

    sendMessageOverDataChannel(message) {
        if (!this.isDataChannelOpen()) {
            return false;
        }
        try {
            this.dataChannel.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('[WebRTCManager] Failed to send DataChannel message:', message, error);
            return false;
        }
    }

    sendFullToggleStateDC() {
        if (!this.isDataChannelOpen()) return;
        const sensorController = SensorController.getExistingInstance();
        if (!sensorController) {
            this.sendMessageOverDataChannel({
                type: 'toggle:state',
                dimension: 'default',
                states: { sX: false, sY: false, sZ: false },
            });
            return;
        }

        const snapshot = sensorController.getAllDimensionToggleStates();
        Object.entries(snapshot).forEach(([dimensionId, states]) => {
            this.sendMessageOverDataChannel({
                type: 'toggle:state',
                dimension: dimensionId,
                states,
            });
        });
    }

    sendToggleSnapshotForDimension(dimensionId) {
        const sensorController = SensorController.getExistingInstance();
        if (!sensorController) {
            return;
        }
        const snapshot = sensorController.getToggleStates(dimensionId);
        this.sendMessageOverDataChannel({
            type: 'toggle:state',
            dimension: dimensionId ?? 'default',
            states: snapshot,
        });
    }

    getWorldModeController() {
        return voiceRegistry.getActive()?.worldMode ?? null;
    }

    getAvailableDimensionDefinitions() {
        const worldMode = this.getWorldModeController();
        if (worldMode?.getAvailableDimensions) {
            try {
                const defs = worldMode.getAvailableDimensions();
                if (Array.isArray(defs) && defs.length) {
                    return defs
                        .map((entry) => ({
                            id: entry?.id ?? entry?.dimensionId ?? entry,
                            label: entry?.label ?? entry?.name ?? entry?.id ?? entry,
                        }))
                        .filter((entry) => Boolean(entry.id));
                }
            } catch (error) {
                console.warn('[WebRTCManager] Failed to read dimensions from WorldModeController:', error);
            }
        }

        const dimensionList = worldMode?.dimensionList;
        if (Array.isArray(dimensionList) && dimensionList.length) {
            const mapped = dimensionList
                .map((entry) => ({
                    id: entry?.id ?? entry,
                    label: entry?.label ?? entry?.id ?? entry,
                }))
                .filter((entry) => Boolean(entry.id));
            if (mapped.length) {
                return mapped;
            }
        }

        const unique = new Map();
        AVAILABLE_EFFECT_DEFINITIONS.forEach((definition = {}) => {
            const manifest = definition.manifest ?? definition;
            const id = manifest?.dimensionId;
            if (!id) {
                return;
            }
            const label = manifest?.dimensionLabel ?? id;
            if (!unique.has(id)) {
                unique.set(id, label);
            }
        });

        if (unique.size === 0) {
            unique.set('default', 'default');
        }

        return Array.from(unique.entries()).map(([id, label]) => ({ id, label }));
    }

    getActiveDimensionId() {
        const worldMode = this.getWorldModeController();
        if (!worldMode) {
            return null;
        }
        if (typeof worldMode.getActiveDimensionId === 'function') {
            try {
                return worldMode.getActiveDimensionId();
            } catch (error) {
                console.warn('[WebRTCManager] Unable to query active dimension:', error);
            }
        }
        return worldMode.activeDimensionId ?? null;
    }

    buildDimensionListPayload() {
        const definitions = this.getAvailableDimensionDefinitions();
        const items = definitions.map((entry) => entry.id);
        const active = this.getActiveDimensionId() ?? (items[0] ?? 'default');
        const sensorController = SensorController.getExistingInstance();
        const states = sensorController ? sensorController.getAllDimensionToggleStates() : {};
        return {
            items,
            active,
            states,
        };
    }

    sendDimensionsList() {
        const payload = this.buildDimensionListPayload();
        const definitions = this.getAvailableDimensionDefinitions();
        this.sendMessageOverDataChannel({
            type: 'dimensions:list',
            items: payload.items,
            active: payload.active,
            states: payload.states,
            definitions,
        });
    }

    sendDimensionActive(dimensionId) {
        const resolved = dimensionId ?? this.getActiveDimensionId();
        if (!resolved) {
            return;
        }
        this.sendMessageOverDataChannel({ type: 'dimension:active', name: resolved });
    }

    // ---- The mobile A/B/C/D orbiter selector -------------------------------------------------

    /** Best-effort human label for an orbiter voice (its track title); null → the phone shows the slot letter. */
    getOrbiterLabel(voice) {
        const track =
            voice?.audioEngine?.trackData?.track ??
            voice?.trackData?.track ??
            voice?.dataManager?.activeView?.track ??
            null;
        const label = track?.title ?? track?.name ?? null;
        return typeof label === 'string' && label.trim() ? label.trim() : null;
    }

    /** Best-effort accent color for an orbiter voice, read off its theme root's `--color1`; null if absent. */
    getOrbiterColor(voice) {
        const el = voice?.themeRoot;
        if (!el || typeof getComputedStyle !== 'function' || !(el instanceof Element)) {
            return null;
        }
        try {
            const color = getComputedStyle(el).getPropertyValue('--color1')?.trim();
            return color || null;
        } catch (_error) {
            return null;
        }
    }

    /** One entry per orbiter (max 4). Slot letters follow the DESKTOP stage order when the layout is
     *  slotted (so the phone's A/B/C/D matches the desktop), else registration order. `active` is the
     *  currently-driven slots — empty while the phone has turned all off (`_sensorSuspended`). */
    buildOrbitersListPayload() {
        // Always source the slots from the LIVE registered voices, so the picker never vanishes if the
        // published stage order is momentarily stale (a reconcile can leave `getSlotOrder()` pointing at
        // ids that just unregistered). Assign each voice its DESKTOP slot letter by stage index when the
        // order still contains it (so phone B == desktop B); the rest fill the remaining free letters in
        // list order. This keeps letters unique and the picker always populated.
        const voices = voiceRegistry.all().slice(0, ORBITER_SLOT_LETTERS.length);
        const byId = new Map(voices.map((voice) => [voice.id, voice]));
        const slots = assignOrbiterSlots(voices.map((voice) => voice.id), voiceRegistry.getSlotOrder?.())
            .map(({ id, slotIndex }) => {
                const voice = byId.get(id);
                return {
                    slot: ORBITER_SLOT_LETTERS[slotIndex],
                    id,
                    label: this.getOrbiterLabel(voice),
                    color: this.getOrbiterColor(voice),
                    available: true,
                };
            });
        const selected = new Set(voiceRegistry.getSelection());
        const active = this._sensorSuspended
            ? []
            : slots.filter((s) => selected.has(s.id)).map((s) => s.slot);
        return { type: 'orbiters:list', slots, active };
    }

    /** Publish the current A/B/C/D roster to the phone (no-op when no DataChannel is open). */
    sendOrbitersList() {
        this.sendMessageOverDataChannel(this.buildOrbitersListPayload());
    }

    /** Coalesce a burst of registry notifications (a multi-slot select fires several) into ONE roster
     *  send on the next microtask, so the phone never renders an intermediate selection. */
    scheduleOrbitersListSync() {
        if (this._orbitersListSyncScheduled) {
            return;
        }
        this._orbitersListSyncScheduled = true;
        const flush = () => {
            this._orbitersListSyncScheduled = false;
            this.sendOrbitersList();
        };
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(flush);
        } else {
            Promise.resolve().then(flush);
        }
    }

    /** Apply a phone slot selection: focus the first, gang the rest (multi-focus). Unknown or
     *  no-longer-available slots are ignored; an empty/all-invalid selection is a no-op (keeps focus). */
    handleOrbitersSelect(message) {
        const voices = voiceRegistry.all();
        let ids;
        if (Array.isArray(message?.ids) && message.ids.length) {
            // Preferred: the phone echoes the exact voice ids from the last roster — immune to slot
            // re-indexing if an orbiter opened/closed between the roster send and this tap.
            const registered = new Set(voices.map((voice) => voice.id));
            ids = message.ids.filter((id) => registered.has(id));
        } else if (Array.isArray(message?.slots) && message.slots.length) {
            // Fallback (ids absent): map slot letters via the SAME order the roster used (stage order when
            // slotted, else registration order) so the mapping is symmetric with buildOrbitersListPayload.
            const order = voiceRegistry.getSlotOrder?.();
            const slotted = Array.isArray(order) && order.length;
            const registered = new Set(voices.map((voice) => voice.id));
            ids = message.slots
                .map((slot) => {
                    const index = ORBITER_SLOT_LETTERS.indexOf(slot);
                    if (index < 0) return null;
                    return (slotted ? order[index] : voices[index]?.id) ?? null;
                })
                .filter((id) => id && registered.has(id)); // drop any stage-slot id no longer registered
        } else {
            ids = [];
        }
        if (!ids.length) {
            // "Turn off all" from the phone: drive NO orbiter. Suspend sensor frames and report an empty
            // active set — but leave the DESKTOP focus untouched (this is a sensor-control gate, not a
            // focus change). scheduleOrbitersListSync re-publishes the now-empty `active` to the phone.
            this._sensorSuspended = true;
            this.scheduleOrbitersListSync();
            return;
        }
        this._sensorSuspended = false;
        try {
            // First selected slot becomes primary (collapses selection); the rest grow it without stealing
            // primary — mirrors the host's own single-vs-multi focus model, which the sensor router follows.
            // The setActive/addToSelection notifications re-publish the roster with the new active slots.
            voiceRegistry.setActive(ids[0]);
            for (let i = 1; i < ids.length; i += 1) {
                voiceRegistry.addToSelection(ids[i]);
            }
        } catch (error) {
            console.warn('[WebRTCManager] Failed to apply orbiters:select', error);
        }
    }

    handleDimensionSet(message) {
        const requested = message?.name ?? message?.dimension ?? null;
        if (!requested) {
            return;
        }

        const available = new Set(this.getAvailableDimensionDefinitions().map((entry) => entry.id));
        if (!available.has(requested)) {
            console.warn('[WebRTCManager] Ignoring dimension:set for unknown dimension:', requested);
            return;
        }

        // Apply the dimension change to EVERY selected orbiter (multi-focus), not just the active one —
        // the phone drives the whole selection with sensors, so the dimension it switches must be visible
        // on all of them (each voice owns its own OrbiterModeController). Single-focus → just the active.
        const targetIds = voiceRegistry.getSelection?.() ?? [];
        const ids = targetIds.length
            ? targetIds
            : (voiceRegistry.activeId ? [voiceRegistry.activeId] : []);
        for (const id of ids) {
            const worldMode = voiceRegistry.get(id)?.worldMode;
            if (typeof worldMode?.setActiveDimension !== 'function') continue;
            try {
                worldMode.setActiveDimension(requested, { source: 'remote-mobile' });
            } catch (error) {
                console.error('[WebRTCManager] Failed to set active dimension for voice', id, error);
            }
        }

        this.sendDimensionActive(requested);
        this.sendToggleSnapshotForDimension(requested);
    }

    sendFullToggleState(targetClientId) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const sensorController = SensorController.getExistingInstance();
        const snapshot = sensorController
            ? sensorController.getAllDimensionToggleStates()
            : { default: { sX: false, sY: false, sZ: false } };

        Object.entries(snapshot).forEach(([dimensionId, states]) => {
            const payload = {
                type: 'toggle:state',
                targetClientId,
                dimension: dimensionId,
                states,
            };
            this.ws.send(JSON.stringify(payload));
        });
    }

    applyToggleStateSnapshot(states, dimension = null) {
        if (!states || typeof states !== 'object') return;
        const sensorController = SensorController.getExistingInstance();
        if (!sensorController) {
            return;
        }
        Object.entries(states).forEach(([key, value]) => {
            sensorController.applyRemoteToggle(key, !!value, dimension);
        });
    }

    /**
     * Applies a toggle message received from the mobile client.
     * @param {{key: string, value: boolean}} message - The incoming message payload.
     */
    handleToggleMessage(message) {
        if (!message || !message.key) {
            return;
        }

        const sensorController = SensorController.getExistingInstance();
        if (!sensorController) {
            return;
        }

        sensorController.applyRemoteToggle(message.key, message.value, message.dimension);
    }

    /**
     * Checks whether an incoming message is intended for this desktop client.
     * @param {{targetClientId?: string}} message - The incoming message.
     * @returns {boolean} True if the message should be handled by this instance.
     */
    isMessageTargetedToDesktop(message) {
        if (!message || !message.targetClientId) {
            return true;
        }
        return message.targetClientId === this.clientId;
    }
}
