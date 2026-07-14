// @vitest-environment node
/**
 * The adapter's source-engine host: one engine per family id, refcounted
 * lifetime (first acquire builds, last release disposes), lifetime observation
 * for visual layers (peek + observe, never refcounting), and ownership of the
 * graph construction a family used to carry — context/mix-bus gating, the
 * build surface (buffer/position/playing/dry-leg), and the mix-bus connect
 * including its failure path.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSourceEngineHost } from '../../src/audio/sourceEngineHost.js';

function createHost(overrides = {}) {
  const io = {
    context: { name: 'rawContext' },
    mixBus: { name: 'mixBus' },
    connect: vi.fn(),
    getBuffer: vi.fn(() => null),
    getPositionMs: vi.fn(() => 0),
    isPlaying: vi.fn(() => false),
    setDryLevel: vi.fn(),
    workletSurface: null,
    ...overrides,
  };
  const host = createSourceEngineHost({
    getContext: () => io.context,
    getMixBus: () => io.mixBus,
    connect: io.connect,
    getBuffer: io.getBuffer,
    getPositionMs: io.getPositionMs,
    isPlaying: io.isPlaying,
    setDryLevel: io.setDryLevel,
    getWorkletSurface: () => io.workletSurface,
  });
  return { host, io };
}

function createStubEngine() {
  return { outputNode: { name: 'out' }, dispose: vi.fn() };
}

describe('source engine host', () => {
  it('shares one engine per family id and disposes on last release', () => {
    const { host } = createHost();
    const created = [];
    const build = () => {
      const engine = createStubEngine();
      created.push(engine);
      return engine;
    };

    const first = host.acquire('granular', build);
    const second = host.acquire('granular', build);
    expect(created.length).toBe(1);
    expect(second.engine).toBe(first.engine);

    first.release();
    expect(created[0].dispose).not.toHaveBeenCalled();
    second.release();
    expect(created[0].dispose).toHaveBeenCalledTimes(1);

    // Double release is inert.
    second.release();
    expect(created[0].dispose).toHaveBeenCalledTimes(1);

    // A fresh acquire after teardown builds a new engine.
    const third = host.acquire('granular', build);
    expect(created.length).toBe(2);
    third.release();
  });

  it('different family ids host independent engines', () => {
    const { host, io } = createHost();
    const granular = host.acquire('granular', createStubEngine);
    const other = host.acquire('other', createStubEngine);
    expect(other.engine).not.toBe(granular.engine);
    expect(io.connect).toHaveBeenCalledTimes(2);
    granular.release();
    expect(host.peek('other')).toBe(other.engine);
    other.release();
  });

  it('hands the build function the construction surface and connects to the mix bus', () => {
    const { host, io } = createHost();
    let seen = null;
    const lease = host.acquire('granular', (buildIo) => {
      seen = buildIo;
      return createStubEngine();
    });

    expect(seen.context).toBe(io.context);
    expect(seen.getBuffer).toBe(io.getBuffer);
    expect(seen.getPositionMs).toBe(io.getPositionMs);
    expect(seen.isPlaying).toBe(io.isPlaying);
    expect(seen.onDryLevelChange).toBe(io.setDryLevel);
    expect(io.connect).toHaveBeenCalledWith(lease.engine.outputNode, io.mixBus);
    lease.release();
  });

  it('hosts a worklet-rendered engine without adding a parallel graph edge', () => {
    const workletSurface = { setParams: vi.fn(), addGrainListener: vi.fn() };
    const { host, io } = createHost({ mixBus: null, workletSurface });
    let seen = null;
    const engine = { outputNode: null, dispose: vi.fn() };
    const lease = host.acquire('granular', (buildIo) => {
      seen = buildIo;
      return engine;
    });

    expect(lease.engine).toBe(engine);
    expect(seen.worklet).toBe(workletSurface);
    expect(io.connect).not.toHaveBeenCalled();
    lease.release();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it('returns null (and never builds) without a context or a mix bus, or when build fails', () => {
    const noContext = createHost({ context: null });
    const build = vi.fn(createStubEngine);
    expect(noContext.host.acquire('granular', build)).toBeNull();
    expect(build).not.toHaveBeenCalled();

    const noBus = createHost({ mixBus: null });
    expect(noBus.host.acquire('granular', build)).toBeNull();
    expect(build).not.toHaveBeenCalled();

    const { host } = createHost();
    expect(host.acquire('granular', () => null)).toBeNull();
    expect(host.acquire('', build)).toBeNull();

    // A worklet alone is not enough for an engine exposing a native output
    // leg: rebind re-routes params, never graph edges, so the bus edge must
    // exist at build or the engine's native mode would be silently unreachable.
    const workletNoBus = createHost({
      mixBus: null,
      workletSurface: { setParams: vi.fn(), addGrainListener: vi.fn() },
    });
    const withOutput = createStubEngine();
    expect(workletNoBus.host.acquire('granular', () => withOutput)).toBeNull();
    expect(withOutput.dispose).toHaveBeenCalledTimes(1);
  });

  it('a lost context blocks attaching to an existing engine (not just building one)', () => {
    const { host, io } = createHost();
    const first = host.acquire('granular', createStubEngine);
    expect(first).not.toBeNull();

    io.context = null;
    expect(host.acquire('granular', createStubEngine)).toBeNull();
    // The blocked acquire never touched the refcount: the sole release disposes.
    first.release();
    expect(first.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('a failed mix-bus connect disposes the engine and hosts nothing', () => {
    const { host } = createHost({ connect: vi.fn(() => { throw new Error('graph edge failed'); }) });
    const engine = createStubEngine();
    const events = [];
    host.observe((id, hosted) => events.push({ id, hosted }));

    expect(host.acquire('granular', () => engine)).toBeNull();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(host.peek('granular')).toBeNull();
    expect(events).toEqual([]);
  });

  it('notifies observers on create and dispose, and peeks the live engine', () => {
    const { host } = createHost();
    const events = [];
    const unsubscribe = host.observe((id, engine) => events.push({ id, engine }));

    expect(host.peek('granular')).toBeNull();

    const engineInstance = createStubEngine();
    const first = host.acquire('granular', () => engineInstance);
    expect(events).toEqual([{ id: 'granular', engine: engineInstance }]);
    expect(host.peek('granular')).toBe(engineInstance);

    // A second acquire attaches to the same engine — no create event.
    const second = host.acquire('granular', createStubEngine);
    expect(events.length).toBe(1);

    first.release();
    expect(events.length).toBe(1);
    second.release();
    expect(events.length).toBe(2);
    expect(events[1]).toEqual({ id: 'granular', engine: null });
    // Dispose runs before the null event lands, so observers see a settled host.
    expect(engineInstance.dispose).toHaveBeenCalledTimes(1);
    expect(host.peek('granular')).toBeNull();

    unsubscribe();
    const third = host.acquire('granular', createStubEngine);
    expect(events.length).toBe(2);
    third.release();
  });

  it('rebind hands every hosted engine the CURRENT worklet surface', () => {
    const { host, io } = createHost();
    const granular = { outputNode: null, dispose: vi.fn(), setWorklet: vi.fn() };
    const other = { outputNode: null, dispose: vi.fn() }; // no setWorklet — must not throw
    const granularLease = host.acquire('granular', () => granular);
    const otherLease = host.acquire('other', () => other);

    // The backend swapped in a worklet (e.g. streaming → stretch unlock).
    const workletSurface = { setParams: vi.fn(), addGrainListener: vi.fn() };
    io.workletSurface = workletSurface;
    expect(() => host.rebind()).not.toThrow();
    expect(granular.setWorklet).toHaveBeenCalledWith(workletSurface);

    // And back to native (e.g. a failed reload reverting to streaming).
    io.workletSurface = null;
    host.rebind();
    expect(granular.setWorklet).toHaveBeenLastCalledWith(null);

    granularLease.release();
    otherLease.release();
  });

  it('a throwing observer never breaks acquire/release', () => {
    const { host } = createHost();
    const unsubscribe = host.observe(() => { throw new Error('observer exploded'); });
    const lease = host.acquire('granular', createStubEngine);
    expect(lease).not.toBeNull();
    expect(() => lease.release()).not.toThrow();
    unsubscribe();
    expect(host.observe(null)).toBeTypeOf('function');
  });
});
