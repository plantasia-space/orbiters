// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mountMultiStageStudio } from '../../src/ui/react/studio/MultiStageStudio.tsx';

let mobileNav = false;

vi.mock('plantasia.space-design/react', () => {
  const passthrough = ({ children, ...props }) => React.createElement('div', props, children);
  const button = ({ children, onClick, onPressedChange, ...props }) =>
    React.createElement(
      'button',
      {
        ...props,
        onClick: (event) => {
          onClick?.(event);
          onPressedChange?.(!props.pressed);
        },
      },
      children,
    );
  return {
    AlertDialog: passthrough,
    AlertDialogAction: button,
    AlertDialogCancel: button,
    AlertDialogContent: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogHeader: passthrough,
    AlertDialogTitle: passthrough,
    Avatar: passthrough,
    AvatarFallback: passthrough,
    AvatarImage: (props) => React.createElement('img', props),
    Badge: passthrough,
    BottomNavBar: passthrough,
    Button: button,
    CornerButton: button,
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: passthrough,
    DropdownMenuSeparator: passthrough,
    DropdownMenuTrigger: passthrough,
    FourCornerCard: passthrough,
    useIsMobileNav: () => mobileNav,
  };
});

vi.mock('plantasia.space-design/icons', () => ({
  Icon: (props) => React.createElement('span', props),
  IconProvider: ({ children }) => React.createElement(React.Fragment, null, children),
}));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia =
    window.matchMedia ||
    ((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
});

afterEach(() => {
  mobileNav = false;
  document.body.innerHTML = '';
});

describe('MultiStageStudio', () => {
  it('mounts a hidden per-stage anchor for each filled stage, without rendering its cover artwork', async () => {
    // The per-stage artwork used to render a real StationTrackCover (image + fallback
    // initial), but it always ended up overlapping some piece of the orbiter's own chrome at one
    // screen size or another. It's now an empty, permanently-hidden anchor div — kept only so it's
    // still this track's MIDI-learn focus target (see the registration test below).
    let mounted;
    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 2,
        stageVoiceIds: ['slot-a', 'slot-b'],
        stageEntries: [
          { title: 'Alpha', image: 'https://example.com/alpha.jpg' },
          { title: 'Zeta', image: null },
        ],
      });
      await Promise.resolve();
    });

    expect(document.querySelector('img[src="https://example.com/alpha.jpg"]')).toBeNull();
    const anchor = document.getElementById('pm-collection-focus-track-0');
    expect(anchor).toBeTruthy();
    expect(anchor.style.display).toBe('none');

    await act(async () => mounted.dispose());
  });

  it('registers each filled stage\'s ARTWORK (not the letter badge) as a MIDI target scoped to its own track, and unregisters on dispose', async () => {
    const registerMidiTarget = vi.fn();
    const unregisterMidiTarget = vi.fn();
    const onFocusStage = vi.fn();
    let mounted;

    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 3,
        stageVoiceIds: ['slot-a', null, 'slot-c'],
        stageEntries: [
          { title: 'Alpha', image: null },
          null,
          { title: 'Gamma', image: null },
        ],
        // A mapping means "select THIS TRACK" — scoped to that track's own real
        // orbiter under one fixed componentId, never a slot letter or a collection-wide anchor.
        focusMidiPersistenceIds: ['orbiter-a', null, 'orbiter-c'],
        onFocusStage,
        registerMidiTarget,
        unregisterMidiTarget,
      });
      await Promise.resolve();
    });

    expect(registerMidiTarget).toHaveBeenCalledTimes(2);
    expect(registerMidiTarget.mock.calls[0][0]).toMatchObject({
      id: 'pm-collection-focus-track-0',
      componentId: 'collection-focus-track',
      componentType: 'kick',
      scope: 'GLOBAL',
      persistenceScope: { scope: 'orbiter', entityId: 'orbiter-a' },
    });
    expect(registerMidiTarget.mock.calls[1][0]).toMatchObject({
      id: 'pm-collection-focus-track-2',
      componentId: 'collection-focus-track',
      persistenceScope: { scope: 'orbiter', entityId: 'orbiter-c' },
    });
    // The registered element is the artwork thumbnail, not the letter badge.
    expect(registerMidiTarget.mock.calls[0][0].element.id).toBe('pm-collection-focus-track-0');

    registerMidiTarget.mock.calls[0][0].onTrigger();
    expect(onFocusStage).toHaveBeenCalledWith(0, false, true);

    await act(async () => mounted.dispose());
    expect(unregisterMidiTarget).toHaveBeenCalledWith('pm-collection-focus-track-0');
    expect(unregisterMidiTarget).toHaveBeenCalledWith('pm-collection-focus-track-2');
  });

  it('registers the collection shell targets (slot focus/add, pager, drawer) under the collection scope', async () => {
    const registerMidiTarget = vi.fn();
    const unregisterMidiTarget = vi.fn();
    const onFocusStage = vi.fn();
    let mounted;

    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 2,
        stageVoiceIds: ['slot-a', 'slot-b'],
        stageEntries: [
          { title: 'Alpha', image: null },
          { title: 'Zeta', image: null },
        ],
        onFocusStage,
        onLoadStage: () => {}, // canArrange → the Cards dock button mounts (a shell target)
        registerMidiTarget,
        unregisterMidiTarget,
        shellMidiCollectionId: 'col-1',
      });
      await Promise.resolve();
    });

    const shellCalls = registerMidiTarget.mock.calls
      .map(([binding]) => binding)
      .filter((binding) => binding.persistenceScope?.scope === 'collection');
    // One select chip per stage + the REAL dock buttons: prev + next + Cards drawer.
    // (Additive per-slot targets were dropped on purpose — no 'add' componentIds.)
    expect(shellCalls).toHaveLength(2 + 3);
    expect(shellCalls.some((binding) => binding.componentId.includes('stage-add'))).toBe(false);
    const byComponent = Object.fromEntries(shellCalls.map((binding) => [binding.componentId, binding]));
    expect(byComponent['collection-stage-focus-1']).toMatchObject({
      componentType: 'kick',
      scope: 'GLOBAL',
      persistenceScope: { scope: 'collection', entityId: 'col-1' },
    });
    // Slot select is POSITION-owned: it fires for the stage index regardless of occupant.
    byComponent['collection-stage-focus-2'].onTrigger();
    expect(onFocusStage).toHaveBeenCalledWith(1, false, true);
    // Pager/drawer targets are the REAL dock buttons; slot focus/add are the learn-only chips.
    expect(byComponent['collection-drawer-toggle'].element.tagName).toBe('BUTTON');
    expect(byComponent['collection-drawer-toggle'].element.id).toBe('pm-collection-drawer-toggle');
    expect(byComponent['collection-stage-prev'].element.tagName).toBe('BUTTON');
    expect(byComponent['collection-stage-focus-1'].element.tagName).toBe('SPAN');

    await act(async () => mounted.dispose());
    expect(unregisterMidiTarget).toHaveBeenCalledWith('pm-collection-stage-focus-1');
    expect(unregisterMidiTarget).toHaveBeenCalledWith('pm-collection-drawer-toggle');
  });

  it('registers no shell targets without a shellMidiCollectionId (flag off / no collection)', async () => {
    const registerMidiTarget = vi.fn();
    let mounted;
    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 2,
        stageVoiceIds: ['slot-a', null],
        stageEntries: [{ title: 'Alpha', image: null }, null],
        registerMidiTarget,
        unregisterMidiTarget: vi.fn(),
      });
      await Promise.resolve();
    });
    const shellCalls = registerMidiTarget.mock.calls
      .map(([binding]) => binding)
      .filter((binding) => binding.persistenceScope?.scope === 'collection');
    expect(shellCalls).toHaveLength(0);
    expect(document.querySelector('.orb-studio__midi-anchor')).toBeNull();
    await act(async () => mounted.dispose());
  });

  it('keeps the artwork MIDI target registered on mobile, but hides it so it does not cover the panel button', async () => {
    // On mobile the artwork overlay used to sit on top of the panel button. It stays MOUNTED
    // (it is this track's MIDI-learn focus target) but is visually hidden (display:none) — the current
    // track shows in the bottom bar instead.
    mobileNav = true;
    const registerMidiTarget = vi.fn();
    let mounted;

    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 1,
        stageVoiceIds: ['slot-a'],
        stageEntries: [{ title: 'Alpha', image: null }],
        focusMidiPersistenceIds: ['orbiter-collection'],
        registerMidiTarget,
        unregisterMidiTarget: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(registerMidiTarget).toHaveBeenCalledTimes(1);
    const artwork = document.getElementById('pm-collection-focus-track-0');
    expect(artwork).toBeTruthy(); // still in the DOM as the MIDI target
    expect(artwork.style.display).toBe('none'); // but hidden on mobile

    await act(async () => mounted.dispose());
  });

  it('does not register a MIDI target for a filled stage with no artwork entry yet', async () => {
    const registerMidiTarget = vi.fn();
    let mounted;

    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 1,
        stageVoiceIds: ['slot-a'],
        stageEntries: [null], // occupied, but no entry metadata to show/map yet
        focusMidiPersistenceIds: ['orbiter-a'],
        registerMidiTarget,
        unregisterMidiTarget: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(registerMidiTarget).not.toHaveBeenCalled();

    await act(async () => mounted.dispose());
  });

  it('does not re-register focus MIDI targets on an unrelated state push (occupancy + owning orbiter unchanged)', async () => {
    const registerMidiTarget = vi.fn();
    const unregisterMidiTarget = vi.fn();
    let mounted;

    await act(async () => {
      mounted = mountMultiStageStudio({
        rosterLength: 1,
        stageVoiceIds: ['slot-a'],
        stageEntries: [{ title: 'Alpha', image: null }],
        focusMidiPersistenceIds: ['orbiter-a'],
        registerMidiTarget,
        unregisterMidiTarget,
      });
      await Promise.resolve();
    });

    expect(registerMidiTarget).toHaveBeenCalledTimes(1);

    // Simulate the real-world churn: createCollectionApp's pushStudioState hands the studio FRESH
    // array references on every reorder/drag, even when which stage is occupied by which real
    // orbiter hasn't changed at all.
    await act(async () => {
      mounted.update({
        stageVoiceIds: ['slot-a'],
        stageEntries: [{ title: 'Alpha (renamed)', image: null }],
        focusMidiPersistenceIds: ['orbiter-a'],
      });
      await Promise.resolve();
    });

    expect(registerMidiTarget).toHaveBeenCalledTimes(1);
    expect(unregisterMidiTarget).not.toHaveBeenCalled();

    await act(async () => mounted.dispose());
  });
});
