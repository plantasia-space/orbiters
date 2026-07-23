/**
 * Granular renderer installed into the vendored Signalsmith processor source.
 * It runs as plain JavaScript in the AudioWorklet and reads the processor's
 * existing PCM arrays, so stretch and granular never retain parallel tracks.
 */
export class WorkletGranularRenderer {
  constructor(sampleRate, emitGrains) {
    this.sampleRate = sampleRate;
    this.emitGrains = emitGrains;
    this.params = {
      wet: 0,
      dryLevel: 1,
      density: 12,
      grainSize: 0.12,
      grainPitch: 1,
      panSpread: 0.3,
      positionSpray: 0.04,
      positionAnchor: -1,
      seekRate: 0,
      reverseProbability: 0,
      envelopeShape: 0.5,
    };
    this.grains = Array.from({ length: 20 }, () => ({ active: false }));
    this.framesUntilNextGrain = 0;
    this.pointerSec = 0;
    this.pointerFollowing = true;
    this.appliedAnchorSec = null;
    this.lastPlayheadSec = 0;
    this.wasActive = false;
    this.currentWet = 0;
    this.currentDry = 1;
    this.events = [];
    this.smoothing = 1 - Math.exp(-1 / (this.sampleRate * 0.03));
  }

  setParams(partial) {
    if (!partial || typeof partial !== 'object') return;
    for (const key of Object.keys(this.params)) {
      const value = Number(partial[key]);
      if (Number.isFinite(value)) this.params[key] = value;
    }
  }

  reset() {
    this.grains.forEach((grain) => { grain.active = false; });
    this.framesUntilNextGrain = 0;
    this.pointerFollowing = true;
    this.appliedAnchorSec = null;
    this.wasActive = false;
  }

  _sampleAt(audioBuffers, channel, frame) {
    if (frame < 0) return 0;
    if (audioBuffers.length === 1) {
      const chunk = audioBuffers[0];
      const data = chunk[channel % chunk.length];
      return data?.[frame] ?? 0;
    }
    let chunkStart = 0;
    for (let i = 0; i < audioBuffers.length; i += 1) {
      const chunk = audioBuffers[i];
      const length = chunk[0]?.length ?? 0;
      if (frame < chunkStart + length) {
        const data = chunk[channel % chunk.length];
        return data?.[frame - chunkStart] ?? 0;
      }
      chunkStart += length;
    }
    return 0;
  }

  _spawn(pointerSec, totalFrames, events, eventTime) {
    let grain = null;
    for (let i = 0; i < this.grains.length; i += 1) {
      if (!this.grains[i].active) {
        grain = this.grains[i];
        break;
      }
    }
    if (!grain || totalFrames <= 1) return;
    const params = this.params;
    const durationFrames = Math.max(1, Math.min(
      totalFrames,
      Math.round(Math.max(0.02, Math.min(0.5, params.grainSize)) * this.sampleRate),
    ));
    const spraySec = params.positionSpray > 0
      ? (Math.random() * 2 - 1) * params.positionSpray
      : 0;
    const maxStart = Math.max(0, totalFrames - durationFrames);
    const startFrame = Math.max(0, Math.min(maxStart, Math.round((pointerSec + spraySec) * this.sampleRate)));
    const reversed = params.reverseProbability > 0 && Math.random() < params.reverseProbability;
    const pitch = Math.max(0.25, Math.min(4, params.grainPitch));
    const pan = params.panSpread > 0
      ? (Math.random() * 2 - 1) * Math.max(0, Math.min(1, params.panSpread))
      : 0;
    const panAngle = Math.abs(pan) * Math.PI * 0.5;

    grain.active = true;
    grain.readPosition = reversed ? startFrame + durationFrames - 1 : startFrame;
    grain.readIncrement = reversed ? -pitch : pitch;
    grain.age = 0;
    grain.durationFrames = durationFrames;
    if (pan < 0) {
      grain.leftFromLeft = 1;
      grain.leftFromRight = Math.sin(panAngle);
      grain.rightFromLeft = 0;
      grain.rightFromRight = Math.cos(panAngle);
    } else {
      grain.leftFromLeft = Math.cos(panAngle);
      grain.leftFromRight = 0;
      grain.rightFromLeft = Math.sin(panAngle);
      grain.rightFromRight = 1;
    }

    events.push({
      time: eventTime,
      positionSec: startFrame / this.sampleRate,
      positionNorm: totalFrames > 0 ? startFrame / totalFrames : 0,
      durationSec: durationFrames / this.sampleRate,
      pan,
      pitch,
      reversed,
    });
  }

  process(output, audioBuffers, playheadSec, playing, transportRate, audioNowSec) {
    const params = this.params;
    const wet = Math.max(0, Math.min(1, params.wet));
    const dry = Math.max(0, Math.min(1, params.dryLevel));
    const blockSize = output[0]?.length ?? 0;
    if (!this.wasActive && wet <= 0.001 && this.currentWet <= 0.001 &&
        dry >= 0.999 && this.currentDry >= 0.999) return;
    // Buffered Orbiters voices currently upload one full-track chunk. Keep the
    // general chunk path for the vendor API without paying callback overhead in
    // every render quantum on the common mobile path. Numeric partial drops are
    // not used; adding them would also need audioBuffersStart-aware grain reads.
    let totalFrames = 0;
    if (audioBuffers.length === 1) {
      totalFrames = audioBuffers[0][0]?.length ?? 0;
    } else {
      for (let i = 0; i < audioBuffers.length; i += 1) {
        totalFrames += audioBuffers[i][0]?.length ?? 0;
      }
    }
    const active = playing && wet > 0.001 && totalFrames > 0 && Number.isFinite(playheadSec);

    if (!active || blockSize === 0) {
      for (let frame = 0; frame < blockSize; frame += 1) {
        this.currentWet += (0 - this.currentWet) * this.smoothing;
        this.currentDry += (dry - this.currentDry) * this.smoothing;
        for (let channel = 0; channel < output.length; channel += 1) {
          output[channel][frame] *= this.currentDry;
        }
      }
      if (this.wasActive) this.reset();
      return;
    }

    const dt = blockSize / this.sampleRate;
    const jump = Math.abs(playheadSec - this.lastPlayheadSec);
    const durationSec = totalFrames / this.sampleRate;
    const seekRate = Math.max(-3, Math.min(3, params.seekRate));
    const anchored = params.positionAnchor >= 0 && durationSec > 0;
    let pointerStep;
    if (anchored) {
      // The anchor is the pointer's HOME: it sits there whenever seek is idle
      // (including after a seek sweep returns to rest), and seekRate travels
      // from it while engaged.
      const anchorSec = Math.max(0, Math.min(1, params.positionAnchor)) * durationSec;
      const anchorSeeking = Math.abs(seekRate) >= 0.001;
      if (!anchorSeeking || this.appliedAnchorSec === null || Math.abs(anchorSec - this.appliedAnchorSec) > 1e-6) {
        this.pointerSec = anchorSec;
        this.appliedAnchorSec = anchorSec;
      }
      this.pointerFollowing = false;
      pointerStep = seekRate;
    } else {
      this.appliedAnchorSec = null;
      const seeking = Math.abs(seekRate) >= 0.001;
      if (!this.wasActive || !seeking || jump > dt * 4 + 0.25) {
        this.pointerSec = playheadSec;
      }
      this.pointerFollowing = !seeking;
      // Decoupled travel runs at playback's natural rate plus the seek offset.
      pointerStep = this.pointerFollowing
        ? (Number.isFinite(transportRate) ? transportRate : 1)
        : 1 + seekRate;
    }
    const events = this.events;
    events.length = 0;
    const density = Math.max(0.5, Math.min(80, params.density));
    const grainIntervalFrames = this.sampleRate / density;
    const envelopeShape = Math.max(0.05, Math.min(0.95, params.envelopeShape));
    const overlap = Math.max(1, density * Math.max(0.02, Math.min(0.5, params.grainSize)));
    const peak = 1 / Math.sqrt(overlap);

    for (let frame = 0; frame < blockSize; frame += 1) {
      this.currentWet += (wet - this.currentWet) * this.smoothing;
      this.currentDry += (dry - this.currentDry) * this.smoothing;
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][frame] *= this.currentDry;
      }
      if (this.framesUntilNextGrain <= 0) {
        this._spawn(this.pointerSec, totalFrames, events, audioNowSec + frame / this.sampleRate);
        this.framesUntilNextGrain += grainIntervalFrames;
      }
      this.framesUntilNextGrain -= 1;

      let left = 0;
      let right = 0;
      for (let index = 0; index < this.grains.length; index += 1) {
        const grain = this.grains[index];
        if (!grain.active) continue;
        const position = grain.readPosition;
        const base = Math.floor(position);
        const fraction = position - base;
        const leftA = this._sampleAt(audioBuffers, 0, base);
        const leftB = this._sampleAt(audioBuffers, 0, base + 1);
        const rightA = this._sampleAt(audioBuffers, 1, base);
        const rightB = this._sampleAt(audioBuffers, 1, base + 1);
        const sourceLeft = leftA + (leftB - leftA) * fraction;
        const sourceRight = rightA + (rightB - rightA) * fraction;
        const phase = grain.age / grain.durationFrames;
        const envelope = phase < envelopeShape
          ? phase / envelopeShape
          : Math.max(0, (1 - phase) / (1 - envelopeShape));
        left += (sourceLeft * grain.leftFromLeft + sourceRight * grain.leftFromRight) * envelope * peak;
        right += (sourceLeft * grain.rightFromLeft + sourceRight * grain.rightFromRight) * envelope * peak;
        grain.readPosition += grain.readIncrement;
        grain.age += 1;
        if (grain.age >= grain.durationFrames || grain.readPosition < 0 || grain.readPosition >= totalFrames - 1) {
          grain.active = false;
        }
      }

      output[0][frame] += left * this.currentWet;
      if (output[1]) output[1][frame] += right * this.currentWet;
      this.pointerSec += pointerStep / this.sampleRate;
      if (!this.pointerFollowing) {
        // An autonomous pointer wraps around the track ends.
        if (this.pointerSec < 0) this.pointerSec += durationSec;
        else if (this.pointerSec >= durationSec) this.pointerSec -= durationSec;
      }
    }

    if (events.length) this.emitGrains(events);
    this.lastPlayheadSec = playheadSec;
    this.wasActive = true;
  }
}

function replaceRequired(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`[GranularWorkletOverlay] Cannot find ${label} in Signalsmith processor source.`);
  }
  return source.replace(needle, replacement);
}

/** Adds the maintained JS renderer to the otherwise unchanged vendor source. */
export function installGranularWorkletOverlay(engineSource) {
  let source = engineSource;
  const classSource = WorkletGranularRenderer.toString();
  source = replaceRequired(
    source,
    'function registerWorkletProcessor(Module, audioNodeKey) {',
    `function registerWorkletProcessor(Module, audioNodeKey) {\n\tconst WorkletGranularRendererImpl = ${classSource};`,
    'processor registration',
  );
  source = replaceRequired(
    source,
    'this.timeIntervalCounter = 0;',
    `this.timeIntervalCounter = 0;\n\t\t\tthis.granular = new WorkletGranularRendererImpl(sampleRate, events => this.port.postMessage(['granularGrains', events]));`,
    'processor constructor',
  );
  source = replaceRequired(
    source,
    `dropBuffers: toSeconds => {`,
    `setGranularParams: params => {\n\t\t\t\t\tthis.granular.setParams(params);\n\t\t\t\t},\n\t\t\t\tdropBuffers: toSeconds => {\n\t\t\t\t\tif (typeof toSeconds !== 'number') this.granular.reset();`,
    'remote methods',
  );
  source = replaceRequired(
    source,
    `let outputTime = currentTime + this.outputLatencySeconds;`,
    `let outputTime = currentTime + this.outputLatencySeconds;\n\t\t\tlet granularInputTime = null;`,
    'render block setup',
  );
  source = replaceRequired(
    source,
    `inputTime += this.inputLatencySeconds;`,
    `granularInputTime = inputTime - currentMapSegment.rate*this.outputLatencySeconds;\n\t\t\t\tinputTime += this.inputLatencySeconds;`,
    'buffered playhead',
  );
  source = replaceRequired(
    source,
    `\t\t\toutputList[0].forEach((channelBuffer, c) => {\n\t\t\t\tlet buffer = new Float32Array(memory, this.buffersOut[c], outputBlockSize);\n\t\t\t\tchannelBuffer.set(buffer);\n\t\t\t});\n\t\t\t\n\t\t\treturn true;`,
    `\t\t\toutputList[0].forEach((channelBuffer, c) => {\n\t\t\t\tlet buffer = new Float32Array(memory, this.buffersOut[c], outputBlockSize);\n\t\t\t\tchannelBuffer.set(buffer);\n\t\t\t});\n\t\t\tthis.granular.process(outputList[0], this.audioBuffers, granularInputTime, currentMapSegment.active, currentMapSegment.rate, currentTime);\n\t\t\t\n\t\t\treturn true;`,
    'render output',
  );
  source = replaceRequired(
    source,
    `if (id == 'time') {`,
    `if (id == 'granularGrains') {\n\t\t\t\taudioNode.onGranularGrains?.(value);\n\t\t\t}\n\t\t\tif (id == 'time') {`,
    'node message bridge',
  );
  return source;
}
