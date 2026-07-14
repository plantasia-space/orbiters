// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import engineSource from '../../src/audio/playback/vendor/signalsmithStretchEngine.js';
import {
  installGranularWorkletOverlay,
  WorkletGranularRenderer,
} from '../../src/audio/playback/granularWorkletOverlay.js';

function constantPcm(value, frames = 48000, channels = 2) {
  return [Array.from({ length: channels }, () => new Float32Array(frames).fill(value))];
}

describe('granular worklet overlay', () => {
  it('installs the renderer and bridge into the vendored processor source', () => {
    const result = installGranularWorkletOverlay(engineSource);
    expect(result).toContain('class WorkletGranularRenderer');
    expect(result).toContain('function registerWorkletProcessor(Module, audioNodeKey) {\n\tconst WorkletGranularRendererImpl = class WorkletGranularRenderer');
    expect(result).toContain('setGranularParams: params =>');
    expect(result).toContain('this.granular.process(outputList[0]');
    expect(result).toContain("id == 'granularGrains'");
  });

  it('binds a stable constructor even when minification renames the class expression', () => {
    const originalToString = WorkletGranularRenderer.toString;
    WorkletGranularRenderer.toString = () => originalToString.call(WorkletGranularRenderer)
      .replace('class WorkletGranularRenderer', 'class B');
    try {
      const result = installGranularWorkletOverlay(engineSource);
      expect(result).toContain('const WorkletGranularRendererImpl = class B');
      expect(result).toContain('new WorkletGranularRendererImpl(sampleRate');
      expect(result).not.toContain('new WorkletGranularRenderer(sampleRate');
    } finally {
      WorkletGranularRenderer.toString = originalToString;
    }
  });

  it('mixes grains from the shared PCM without changing the PCM', () => {
    const pcm = constantPcm(1);
    const original = pcm[0][0][0];
    const renderer = new WorkletGranularRenderer(48000, vi.fn());
    renderer.setParams({ wet: 1, dryLevel: 0, density: 20, grainSize: 0.1 });
    const output = [new Float32Array(128), new Float32Array(128)];

    renderer.process(output, pcm, 0.2, true, 1, 1);

    expect(output[0].some((sample) => sample > 0)).toBe(true);
    expect(output[1].some((sample) => sample > 0)).toBe(true);
    expect(pcm[0][0][0]).toBe(original);
  });

  it('supports reverse grains and emits the existing visual event shape', () => {
    const emit = vi.fn();
    const renderer = new WorkletGranularRenderer(48000, emit);
    renderer.setParams({ wet: 1, reverseProbability: 1, density: 20 });
    renderer.process(
      [new Float32Array(128), new Float32Array(128)],
      constantPcm(0.5),
      0.5,
      true,
      1,
      2,
    );

    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0][0]).toMatchObject({
      reversed: true,
      pitch: 1,
      time: 2,
    });
  });
});
