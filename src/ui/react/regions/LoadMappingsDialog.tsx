/**
 * @file src/ui/react/regions/LoadMappingsDialog.tsx
 * @description The load-saved-MIDI-mappings dialog. Opened by the "Open" button in the
 * MIDI-mode header (via `loadMappingsDialogStore`). Lists the user's OTHER orbiters that have saved
 * mappings (by name + count, alphabetical), and loads a chosen one INTO the current orbiter,
 * REPLACING its mappings (copy-first-then-clear, then re-applied live).
 *
 * Efficiency: the full mapping tree + names is fetched ONLY here, when the dialog opens
 * (`fetchMidiMappings()` with no orbiterId). Every orbiter open uses the scoped fetch instead.
 */
import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Progress,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from 'plantasia.space-design/react';
import { useEngine, useEngineMidi } from '../../../react/engine/EngineContext';
import { useEngineSubscription, type EngineSubscribable } from '../../../react/engine/useEngineSubscription';
import { voiceRegistry } from '../../../voice/VoiceRegistry.js';
import { fetchMidiMappings, replaceScopedMappings } from '../../../api/midiLearnService.js';
import notifications from '../../../core/AppNotifications.js';
import { getT } from '../../../i18n/index.js';
import {
  isLoadMappingsDialogOpen,
  closeLoadMappingsDialog,
  subscribeLoadMappingsDialog,
} from './loadMappingsDialogStore';
import { usePortalContainer } from '../PortalContainerProvider';

/** Stable identity for `useEngineSubscription` (re-render on open/close). */
const LOAD_MAPPINGS_SUBSCRIBABLE: EngineSubscribable = { subscribe: subscribeLoadMappingsDialog };

/** Re-render when the ACTIVE voice changes — the ownership gate below keys off it. */
const ACTIVE_VOICE_SUBSCRIBABLE: EngineSubscribable = {
  subscribe: (listener) => voiceRegistry.onActiveChange(listener),
};

/** Show the name filter only once the list is long enough to need it — small lists stay clean.
 *  The whole tree is already fetched on open, so filtering is purely client-side. */
const FILTER_THRESHOLD = 8;

type SourceEntry = { id: string; name: string; count: number };
/** Which slice a row copies into: orbiter parameter mappings, or collection shell mappings. */
type SourceKind = 'orbiter' | 'collection';
type Status = 'loading' | 'ready' | 'error' | 'saving';
type SliceBindings = Record<string, Record<string, object>>;
type MidiLearnResponse = {
  midiLearn?: { orbiters?: SliceBindings; collections?: SliceBindings };
  orbiterNames?: Record<string, string>;
  collectionNames?: Record<string, string>;
};

export function LoadMappingsDialog() {
  useEngineSubscription(LOAD_MAPPINGS_SUBSCRIBABLE);
  useEngineSubscription(ACTIVE_VOICE_SUBSCRIBABLE);
  // One LoadMappingsDialog mounts per VOICE root (OrbitersUI), and every instance subscribes
  // to the same open-store — so in the collection studio N loaded orbiters used to open N
  // STACKED dialogs (visible as layers once their contents could differ) and fire N identical
  // full-tree fetches. Only the ACTIVE voice's instance owns the dialog: exactly one dialog,
  // one fetch, rendered in the portal that carries the theme of the orbiter whose header
  // opened it. Single-orbiter (voiceId null) is the sole instance and always owns it.
  const { voiceId } = useEngine();
  const isOwner = voiceId == null || voiceRegistry.activeId === voiceId;
  const open = isLoadMappingsDialogOpen() && isOwner;
  const midi = useEngineMidi();
  const portalContainer = usePortalContainer();
  const t = getT();

  const [status, setStatus] = useState<Status>('loading');
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  // The full source trees (id → {paramId → binding}) and the current targets' existing params,
  // captured at open so the load doesn't re-fetch.
  const [tree, setTree] = useState<SliceBindings>({});
  const [currentParamIds, setCurrentParamIds] = useState<string[]>([]);
  // Collection shell mappings (only relevant inside the collection studio — see currentCollectionId).
  const [collectionEntries, setCollectionEntries] = useState<SourceEntry[]>([]);
  const [collectionTree, setCollectionTree] = useState<SliceBindings>({});
  const [currentShellParamIds, setCurrentShellParamIds] = useState<string[]>([]);
  const [pending, setPending] = useState<{ entry: SourceEntry; kind: SourceKind } | null>(null);
  // Inside the collection studio the dialog splits into two tabs (orbiter vs collection-shell
  // sources); outside it, no tabs — just the orbiter list as always.
  const [hasCollectionTab, setHasCollectionTab] = useState(false);
  const [tab, setTab] = useState<SourceKind>('orbiter');
  const [query, setQuery] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // Bumped by "Try again" so the fetch effect re-runs (its other deps don't change on retry).
  const [reloadNonce, setReloadNonce] = useState(0);

  const mappingsLabel = (count: number) =>
    count === 1 ? t('midiLoad.mappingsOne', { count }) : t('midiLoad.mappingsOther', { count });

  // While the modal is open, suppress the MIDI-learn floating chrome (the fixed exit ✕ sits at a
  // max z-index and would otherwise poke through the dialog; overlays, badges, anchors and header
  // buttons are noise mid-selection). The class is removed on close / unmount. ONLY the owner
  // instance touches this shared body class — a non-owner sibling (open=false) running the same
  // toggle would strip it right after the owner set it, letting overlays bleed over the modal.
  useEffect(() => {
    if (typeof document === 'undefined' || !isOwner) return;
    document.body.classList.toggle('orbiters-load-dialog-open', open);
    return () => document.body.classList.remove('orbiters-load-dialog-open');
  }, [open, isOwner]);

  useEffect(() => {
    if (!open) {
      // Reset for the next open.
      setStatus('loading');
      setEntries([]);
      setTree({});
      setCurrentParamIds([]);
      setCollectionEntries([]);
      setCollectionTree({});
      setCurrentShellParamIds([]);
      setHasCollectionTab(false);
      setTab('orbiter');
      setPending(null);
      setQuery('');
      setProgress({ done: 0, total: 0 });
      setReloadNonce(0);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const data = (await fetchMidiMappings()) as MidiLearnResponse; // full tree + names (dialog-only)
        if (cancelled) return;
        const orbiters: SliceBindings = data?.midiLearn?.orbiters ?? {};
        const names: Record<string, string> = data?.orbiterNames ?? {};
        const currentId = midi.currentOrbiterId();

        const list: SourceEntry[] = Object.entries(names)
          // Names are the source of truth for "existing + viewable" orbiters; require a real name so
          // a raw id never shows (the backend already omits nameless ones — belt and braces).
          .filter(([id, name]) => id !== currentId && !!name)
          .map(([id, name]) => ({ id, name, count: Object.keys(orbiters[id] ?? {}).length }))
          .filter((entry) => entry.count > 0)
          .sort((a, b) => a.name.localeCompare(b.name));

        setTree(orbiters);
        setCurrentParamIds(currentId ? Object.keys(orbiters[currentId] ?? {}) : []);
        setEntries(list);

        // Collection shell mappings — a second, independent section shown only inside the
        // collection studio (currentCollectionId): copy another collection's shell layout
        // (slot focus/add, pager, drawer) into THIS collection. Same viewable+named contract.
        const currentCollection = midi.currentCollectionId();
        setHasCollectionTab(Boolean(currentCollection));
        if (currentCollection) {
          const collections: SliceBindings = data?.midiLearn?.collections ?? {};
          const cNames: Record<string, string> = data?.collectionNames ?? {};
          const cList: SourceEntry[] = Object.entries(cNames)
            .filter(([id, name]) => id !== currentCollection && !!name)
            .map(([id, name]) => ({ id, name, count: Object.keys(collections[id] ?? {}).length }))
            .filter((entry) => entry.count > 0)
            .sort((a, b) => a.name.localeCompare(b.name));
          setCollectionTree(collections);
          setCurrentShellParamIds(Object.keys(collections[currentCollection] ?? {}));
          setCollectionEntries(cList);
        }
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, midi, reloadNonce]);

  const onLoadClick = (entry: SourceEntry, kind: SourceKind) => {
    const existing = kind === 'orbiter' ? currentParamIds : currentShellParamIds;
    if (existing.length > 0) {
      setPending({ entry, kind }); // needs confirm-on-overwrite
    } else {
      void doLoad(entry, kind);
    }
  };

  const doLoad = async (entry: SourceEntry, kind: SourceKind) => {
    const currentId = kind === 'orbiter' ? midi.currentOrbiterId() : midi.currentCollectionId();
    if (!currentId) {
      setStatus('error');
      return;
    }
    setStatus('saving');
    setPending(null);
    setProgress({ done: 0, total: 0 });
    try {
      await replaceScopedMappings({
        scope: kind,
        sourceBindings: (kind === 'orbiter' ? tree : collectionTree)[entry.id] ?? {},
        targetEntityId: currentId,
        targetParamIds: kind === 'orbiter' ? currentParamIds : currentShellParamIds,
        onProgress: (done, total) => setProgress({ done, total }),
      });
    } catch {
      // Copy-first-then-clear means the orbiter is never empty mid-failure. Sync the live runtime
      // to whatever actually persisted, surface the error, and keep the dialog open.
      await midi.reloadPersistedMappings().catch(() => {});
      notifications.showToast(t('midiLoad.loadError'), 'warning', 4000);
      setStatus('ready');
      return;
    }
    // The writes succeeded — re-apply into the live runtime as a best-effort step that must NOT
    // downgrade a successful load to an error (its failure only delays the live refresh).
    await midi.reloadPersistedMappings().catch(() => {});
    notifications.showToast(
      entry.count === 1
        ? t('midiLoad.successOne', { count: entry.count, name: entry.name })
        : t('midiLoad.successOther', { count: entry.count, name: entry.name }),
      'success',
      4000,
    );
    closeLoadMappingsDialog();
  };

  const q = query.trim().toLowerCase();
  const visible = q ? entries.filter((entry) => entry.name.toLowerCase().includes(q)) : entries;
  const showFilter = entries.length > FILTER_THRESHOLD;
  const saving = status === 'saving';
  const ready = status === 'ready'; // the picker list shows only when not mid-load
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const renderRows = (list: SourceEntry[], kind: SourceKind) => (
    <ul className="orbiters-load-mappings-dialog__list">
      {list.map((entry) => {
        const confirming = pending?.entry.id === entry.id && pending?.kind === kind;
        const existingCount = kind === 'orbiter' ? currentParamIds.length : currentShellParamIds.length;
        const confirmText =
          kind === 'orbiter'
            ? existingCount === 1
              ? t('midiLoad.replaceConfirmOne', { count: existingCount, name: entry.name })
              : t('midiLoad.replaceConfirmOther', { count: existingCount, name: entry.name })
            : existingCount === 1
              ? t('midiLoad.replaceShellConfirmOne', { count: existingCount, name: entry.name })
              : t('midiLoad.replaceShellConfirmOther', { count: existingCount, name: entry.name });
        return (
          <li key={entry.id} className="orbiters-load-mappings-dialog__row" data-confirming={confirming || undefined}>
            {confirming ? (
              <>
                <span className="orbiters-load-mappings-dialog__confirm-text">{confirmText}</span>
                <span className="orbiters-load-mappings-dialog__row-actions">
                  <Button variant="ghost" onClick={() => setPending(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant={kind === 'orbiter' ? 'successOutlined' : 'outline'}
                    className={kind === 'collection' ? 'orbiters-load-mappings-dialog__load-collection' : undefined}
                    onClick={() => void doLoad(entry, kind)}
                  >
                    {t('midiLoad.replace')}
                  </Button>
                </span>
              </>
            ) : (
              <>
                <span className="orbiters-load-mappings-dialog__row-info">
                  <span className="orbiters-load-mappings-dialog__row-name">{entry.name}</span>
                  <span className="orbiters-load-mappings-dialog__row-count">{mappingsLabel(entry.count)}</span>
                </span>
                <Button
                  variant={kind === 'orbiter' ? 'successOutlined' : 'outline'}
                  className={kind === 'collection' ? 'orbiters-load-mappings-dialog__load-collection' : undefined}
                  onClick={() => onLoadClick(entry, kind)}
                  aria-label={
                    kind === 'orbiter'
                      ? t('midiLoad.loadAria', { name: entry.name })
                      : t('midiLoad.loadShellAria', { name: entry.name })
                  }
                >
                  {t('midiLoad.load')}
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );

  // The orbiter sources (empty state + name filter + rows) — rendered bare outside the
  // collection studio, or inside the "Orbiter" tab within it.
  const orbiterList = (
    <>
      {entries.length === 0 && (
        <p className="orbiters-load-mappings-dialog__status">{t('midiLoad.empty')}</p>
      )}
      {entries.length > 0 && showFilter && (
        <div className="orbiters-load-mappings-dialog__filter">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('midiLoad.searchPlaceholder')}
            aria-label={t('midiLoad.searchPlaceholder')}
          />
          <span className="orbiters-load-mappings-dialog__filter-count">
            {t('midiLoad.filterCount', { shown: visible.length, total: entries.length })}
          </span>
        </div>
      )}
      {entries.length > 0 && visible.length === 0 && (
        <p className="orbiters-load-mappings-dialog__status">{t('midiLoad.noMatches')}</p>
      )}
      {visible.length > 0 && renderRows(visible, 'orbiter')}
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        // Don't let the dialog be dismissed mid-load — the sequential writes are in flight.
        if (!isOpen && !saving) closeLoadMappingsDialog();
      }}
    >
      <DialogContent className="orbiters-load-mappings-dialog" data-ui-interactive container={portalContainer ?? undefined}>
        <DialogHeader>
          <DialogTitle>{t('midiLoad.openTitle')}</DialogTitle>
        </DialogHeader>
        <p className="orbiters-load-mappings-dialog__description">
          {tab === 'collection' ? t('midiLoad.collectionDescription') : t('midiLoad.description')}
        </p>

        {status === 'loading' && (
          <p className="orbiters-load-mappings-dialog__status">{t('midiLoad.loading')}</p>
        )}

        {status === 'error' && (
          <div className="orbiters-load-mappings-dialog__status">
            <p>{t('midiLoad.fetchError')}</p>
            <Button variant="ghost" onClick={() => setReloadNonce((n) => n + 1)}>
              {t('midiLoad.retry')}
            </Button>
          </div>
        )}

        {saving && (
          <div className="orbiters-load-mappings-dialog__loading" role="status" aria-live="polite">
            <Progress value={pct} className="orbiters-load-mappings-dialog__progress" />
            <p className="orbiters-load-mappings-dialog__loading-text">
              {t('midiLoad.loadingProgress', { done: progress.done, total: progress.total })}
            </p>
          </div>
        )}

        {/* Inside the collection studio the sources split into two line tabs (orbiter parameter
            mappings vs collection shell mappings); outside it there's no collection target, so
            the orbiter list renders alone exactly as before. */}
        {ready && !hasCollectionTab && orbiterList}

        {ready && hasCollectionTab && (
          <Tabs value={tab} onValueChange={(next) => setTab(next as SourceKind)}>
            <TabsList>
              <TabsTrigger value="orbiter">{t('midiLoad.orbiterTab')}</TabsTrigger>
              <TabsTrigger value="collection">{t('midiLoad.collectionTab')}</TabsTrigger>
            </TabsList>
            <TabsContent value="orbiter" className="orbiters-load-mappings-dialog__tab">
              {orbiterList}
            </TabsContent>
            <TabsContent value="collection" className="orbiters-load-mappings-dialog__tab">
              {collectionEntries.length === 0 ? (
                <p className="orbiters-load-mappings-dialog__status">{t('midiLoad.emptyCollections')}</p>
              ) : (
                renderRows(collectionEntries, 'collection')
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
