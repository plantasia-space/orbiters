/**
 * @file src/ui/react/regions/SensorPairingDialog.tsx
 * @description The React "Connect External Sensor" pairing dialog (Tier-1 vanilla→React migration).
 *
 * Replaces the imperative DOM that `WebRTCManager` used to build through the vanilla
 * `AppNotifications.showUniversalModal` (the QR connect/reconnect modal + the local-sensor choice
 * cards). The manager keeps its state machine and, under `?ui=react`, PUBLISHES the pairing view on
 * `orbiters:sensor-pairing`; this region reads it through the `connection.pairing` surface and renders
 * the design-lib `Dialog`. React never reaches into the manager's DOM; the manager never builds markup.
 *
 * Two views:
 *  - `qr`     — QR code + manual pairing link (connect vs reconnect copy).
 *  - `choice` — "use the already-connected device" vs "connect a new device" cards (shown when a local
 *               same-machine sensor source is available).
 *
 * The dialog auto-closes when a device becomes live-connected (`connection.isConnected()`), mirroring
 * the legacy `closeModal()` the manager fired on a successful pair.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from 'plantasia.space-design/react';
import { useEngineConnection } from '../../../react/engine/EngineContext';
import type { PairingState, PairingSource } from '../../../react/engine/engineTypes';
import { getT } from '../../../i18n/index.js';
import { usePortalContainer } from '../PortalContainerProvider';

// The choice-card diagrams (carried over from the legacy modal — WebRTCManager.js).
const OPTION_A_DIAGRAM =
  'https://plantasia-prod-public.fra1.digitaloceanspaces.com/assets/symbols/current/orbiters/option-A.png';
const OPTION_B_DIAGRAM =
  'https://plantasia-prod-public.fra1.digitaloceanspaces.com/assets/symbols/current/orbiters/option-B.png';

/** Render an i18n string that may contain `<br>` as real line breaks (no HTML injection). */
function MultilineText({ value }: { value: string }) {
  const lines = value.split(/<br\s*\/?>/i);
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

function QrView({ pairing }: { pairing: PairingState }) {
  const t = getT();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);

  // Generate the QR asynchronously off the pairing URL; guard against a stale resolve
  // (the dialog may have re-opened with a different URL, or closed) writing back.
  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrError(false);
    QRCode.toDataURL(pairing.pairingInfo, { width: 150 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pairing.pairingInfo]);

  return (
    <div className="orbiters-sensor-pairing__qr">
      {pairing.reconnect ? (
        <p className="orbiters-sensor-pairing__heading">{t('sensors.modal.disconnectedHeading')}</p>
      ) : null}
      <p className="orbiters-sensor-pairing__desc">
        <MultilineText
          value={
            pairing.reconnect
              ? t('sensors.modal.disconnectedDescription')
              : t('sensors.modal.connectDescription')
          }
        />
      </p>
      {qrError ? (
        <p className="orbiters-sensor-pairing__error">{t('notifications.qrGenerationError')}</p>
      ) : (
        <img
          className="orbiters-sensor-pairing__qr-img"
          src={qrDataUrl ?? undefined}
          alt="QR Code"
          width={150}
          height={150}
        />
      )}
      <p className="orbiters-sensor-pairing__manual">
        {t('sensors.modal.manualEntry')}
        <br />
        <a href={pairing.pairingInfo} target="_blank" rel="noreferrer">
          {pairing.pairingInfo}
        </a>
      </p>
    </div>
  );
}

function ChoiceView({
  pairing,
  onUseConnected,
  onConnectNew,
}: {
  pairing: PairingState;
  onUseConnected: (source: PairingSource) => void;
  onConnectNew: () => void;
}) {
  const t = getT();
  const primary = pairing.sources[0];
  return (
    <div className="orbiters-sensor-pairing__choice">
      <PairingCard
        title={t('sensors.modal.sharedChoice.useConnected.title')}
        description={t('sensors.modal.sharedChoice.useConnected.description')}
        diagram={OPTION_A_DIAGRAM}
        disabled={!primary}
        onSelect={() => primary && onUseConnected(primary)}
      />
      <PairingCard
        title={t('sensors.modal.sharedChoice.connectNew.title')}
        description={t('sensors.modal.sharedChoice.connectNew.description')}
        diagram={OPTION_B_DIAGRAM}
        onSelect={onConnectNew}
      />
    </div>
  );
}

/** A selectable option, built from the design-lib `Card` (border/radius/title/description come from
 *  the lib) made keyboard-activatable — only the diagram sizing + the disabled cursor are local. */
function PairingCard({
  title,
  description,
  diagram,
  disabled = false,
  onSelect,
}: {
  title: string;
  description: string;
  diagram: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={title}
      className="orbiters-sensor-pairing__card"
      onClick={() => !disabled && onSelect()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <img src={diagram} alt="" loading="lazy" decoding="async" />
      </CardContent>
    </Card>
  );
}

export function SensorPairingDialog() {
  const connection = useEngineConnection();
  const portalContainer = usePortalContainer();
  const [pairing, setPairing] = useState<PairingState | null>(null);

  // Subscribe to the manager's published pairing view.
  useEffect(() => connection.pairing.subscribe(setPairing), [connection]);

  // Auto-close once a device is live-connected (mirrors the legacy closeModal() on pair).
  useEffect(() => {
    if (!pairing) return;
    return connection.subscribe(() => {
      if (connection.isConnected()) setPairing(null);
    });
  }, [connection, pairing]);

  const close = () => {
    setPairing(null);
    connection.pairing.close();
  };

  const t = getT();
  const title = pairing?.reconnect
    ? t('sensors.modal.reconnectTitle')
    : t('sensors.modal.connectTitle');

  return (
    <Dialog
      open={pairing != null}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
    >
      <DialogContent className="orbiters-sensor-pairing" data-ui-interactive container={portalContainer ?? undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {pairing?.view === 'choice' ? (
          <ChoiceView
            pairing={pairing}
            onUseConnected={(source) => connection.pairing.useConnectedSource(source)}
            onConnectNew={() => connection.pairing.connectNewDevice(pairing.reconnect)}
          />
        ) : pairing ? (
          <QrView pairing={pairing} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
