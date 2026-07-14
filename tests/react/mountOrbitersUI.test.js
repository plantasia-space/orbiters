// @vitest-environment jsdom
/**
 * @file tests/react/mountOrbitersUI.test.js
 * @description A grid cell holds exactly ONE orbiter interface.
 *
 * A stage's cell outlives the voice that filled it (the slot layout owns the cell DOM), and every
 * placement mints a fresh voiceId → a fresh host id. So the same-id teardown cannot reap a host left
 * behind by a previous placement: without the container sweep, a stale interface stacks under the new
 * one and the "empty" placeholder keeps showing knobs + transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('plantasia.space-design/styles.css', () => ({}));
vi.mock('../../src/ui/react/orbitersUI.css', () => ({}));
vi.mock('../../src/ui/react/OrbitersUI', () => ({ OrbitersUI: () => null }));
vi.mock('../../src/ui/react/resolveEngineSingletons', () => ({
    resolveEngineContext: () => ({ context: {}, report: {} }),
}));
vi.mock('../../src/ui/react/engineResolution', () => ({
    warnOnMissingExpectedSurfaces: () => {},
}));

const HOST_ID = 'orbiters-react-ui-root';
const hostsIn = (cell) => Array.from(cell.children).filter((el) => el.id.startsWith(`${HOST_ID}-`));

let mountOrbitersUI;

beforeEach(async () => {
    ({ mountOrbitersUI } = await import('../../src/ui/react/mountOrbitersUI.tsx'));
});

afterEach(() => {
    document.body.innerHTML = '';
    document.body.removeAttribute('data-ui-react');
    document.documentElement.classList.remove('dark');
});

describe('mountOrbitersUI — one interface per placeholder', () => {
    it('reaps a stale host left by a previous placement in the same cell', () => {
        const cell = document.createElement('div');
        document.body.appendChild(cell);

        // Placement 1 mounts, then its voice is disposed WITHOUT unmounting (the mid-boot race:
        // dispose ran before the mount landed, so nothing ever tore this root down).
        mountOrbitersUI({ parameterManager: null, container: cell, voiceId: 'track-a::1' });
        expect(hostsIn(cell)).toHaveLength(1);

        // Placement 2 into the SAME cell: distinct minted voiceId → distinct host id.
        mountOrbitersUI({ parameterManager: null, container: cell, voiceId: 'track-a::2' });

        const hosts = hostsIn(cell);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].id).toBe(`${HOST_ID}-track-a::2`);
    });

    it("leaves a sibling cell's live interface alone", () => {
        const cellA = document.createElement('div');
        const cellD = document.createElement('div');
        document.body.append(cellA, cellD);

        mountOrbitersUI({ parameterManager: null, container: cellA, voiceId: 'track-a::1' });
        mountOrbitersUI({ parameterManager: null, container: cellD, voiceId: 'track-a::2' });

        expect(hostsIn(cellA)).toHaveLength(1);
        expect(hostsIn(cellD)).toHaveLength(1);
    });

    it('does not sweep body siblings in the single-orbiter (no container) mount', () => {
        const unrelated = document.createElement('div');
        unrelated.id = `${HOST_ID}-someone-else`;
        document.body.appendChild(unrelated);

        mountOrbitersUI({ parameterManager: null });

        expect(document.getElementById(`${HOST_ID}-someone-else`)).not.toBeNull();
        expect(document.getElementById(HOST_ID)).not.toBeNull();
    });

    it('does not disturb non-host children of the cell (e.g. the load overlay)', () => {
        const cell = document.createElement('div');
        const overlay = document.createElement('div');
        overlay.className = 'voice-load-overlay';
        cell.appendChild(overlay);
        document.body.appendChild(cell);

        mountOrbitersUI({ parameterManager: null, container: cell, voiceId: 'track-a::1' });
        mountOrbitersUI({ parameterManager: null, container: cell, voiceId: 'track-a::2' });

        expect(cell.querySelector('.voice-load-overlay')).toBe(overlay);
    });
});
