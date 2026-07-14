import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Panel, Section, PropRow, Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from 'plantasia.space-design/react';
import 'plantasia.space-design/styles.css';
import { DesignFolder, type OrbiterDesign } from '../src/orbiter/edit/react/DesignFolder';
import {
  RackFolder, type AxisRack, type RackModuleOption, type Axis, type RangeKey,
} from '../src/orbiter/edit/react/RackFolder';

/**
 * Surface #1 harness — now exercising the panel built from the SHARED library components
 * (Panel / Section / Field / PropRow / ColorControl / Switch / Select + arrow Slider). It stands in
 * for OrbitersEditPanel: owns state and records what each control fires, proving the controls route
 * through the same seam shapes (Dimensions → `_handleActiveDimensionChange`; Design → `onDesignChange`;
 * Engine/rack → `handleModuleSelectionChange` / `handleRangeChange` with live-vs-broadcast) without
 * the full app/edit-mode boot. (edit-panel-connect-check.tsx drives the REAL panel.)
 */
interface DimensionOption { value: string; label: string; }

const STUB_OPTIONS: DimensionOption[] = [
  { value: 'dim-default', label: 'Dimension · Default' },
  { value: 'dim-aurora', label: 'Dimension · Aurora' },
  { value: 'dim-tidal', label: 'Dimension · Tidal' },
];

const STUB_DESIGN: OrbiterDesign = {
  colorPrimary: '#7aa2f7',
  colorSecondary: '#bb9af7',
  colorC: '#33ff41',
  roundedCorners: 12,
  frameBorderWidth: 2,
  ringEnabled: true,
  ringColor: '#9ece6a',
  ringAmplitudeMultiplier: 3,
  ringRadiusMultiplier: 1.5,
};

// Stub module catalog (real one comes from DimensionModuleCatalog: { label: 'effectId::moduleId' }).
const MODULE_OPTIONS: RackModuleOption[] = [
  { value: 'none', label: 'None', domain: null },
  { value: 'tone.pitchshift::down', label: 'Pitch Shifter › Nebula Slide Down', domain: { min: -100, max: 100 } },
  { value: 'tone.pitchshift::up', label: 'Pitch Shifter › Nebula Slide Up', domain: { min: -100, max: 100 } },
  { value: 'tone.reverb::hall', label: 'Reverb › Hall', domain: { min: 0, max: 100 } },
  { value: 'tone.filter::lowpass', label: 'Filter › Lowpass', domain: { min: 20, max: 20000 } },
];

const INITIAL_AXES: AxisRack[] = [
  { axis: 'x', visualFeedback: true, slot: { moduleKey: 'tone.pitchshift::down', domain: { min: -100, max: 100 }, range: { min: -60, max: 60, equilibrium: 0 } } },
  { axis: 'y', visualFeedback: true, slot: { moduleKey: 'none', domain: null, range: { min: null, max: null, equilibrium: null } } },
  { axis: 'z', visualFeedback: null, slot: { moduleKey: 'none', domain: null, range: { min: null, max: null, equilibrium: null } } },
];

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

function Harness() {
  const [dimension, setDimension] = useState('dim-default');
  const [design, setDesign] = useState<OrbiterDesign>(STUB_DESIGN);
  const [axes, setAxes] = useState<AxisRack[]>(INITIAL_AXES);
  const [changes, setChanges] = useState(0);   // design + dimension broadcasts
  const [rackCommits, setRackCommits] = useState(0); // rack broadcasts (module select + range commit)
  const [rackLive, setRackLive] = useState(0);  // live (non-broadcast) range drags

  const handleDimension = (next: string) => { setDimension(next); setChanges((n) => n + 1); };
  const handleDesign = (patch: Partial<OrbiterDesign>) => {
    setDesign((d) => ({ ...d, ...patch }));
    setChanges((n) => n + 1);
  };

  // Mirrors applyVisualFeedbackChange: the module's visual switch — the sound is untouched.
  const handleVisualFeedbackChange = (axis: Axis, enabled: boolean) => {
    setAxes((prev) => prev.map((a) => (a.axis !== axis ? a : { ...a, visualFeedback: enabled })));
    setRackCommits((n) => n + 1);
  };

  // Mirrors handleModuleSelectionChange: swap the module, seed default range from its domain, broadcast.
  const handleModuleChange = (axis: Axis, _index: number, moduleKey: string) => {
    const domain = MODULE_OPTIONS.find((o) => o.value === moduleKey)?.domain ?? null;
    setAxes((prev) => prev.map((a) => (a.axis !== axis ? a : {
      ...a,
      slot: {
        moduleKey,
        domain,
        range: domain
          ? { min: domain.min, max: domain.max, equilibrium: clamp(0, domain.min, domain.max) }
          : { min: null, max: null, equilibrium: null },
      },
    })));
    setRackCommits((n) => n + 1);
  };

  // Mirrors handleRangeChange(axis, index, key, value, {shouldBroadcast}): live updates the value;
  // only a commit (shouldBroadcast) counts as a broadcast to the rest of the app.
  const handleRangeChange = (axis: Axis, _index: number, key: RangeKey, value: number, opts: { shouldBroadcast: boolean }) => {
    setAxes((prev) => prev.map((a) => (a.axis !== axis ? a : {
      ...a,
      slot: { ...a.slot, range: { ...a.slot.range, [key]: value } },
    })));
    if (opts.shouldBroadcast) setRackCommits((n) => n + 1);
    else setRackLive((n) => n + 1);
  };

  return (
    <main style={{ padding: 24, maxWidth: 420 }}>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>orbiters · edit-panel (shared library components)</h1>

      <Panel title="Edit">
        <Section title="Dimensions">
          <PropRow label="Dimension">
            <Select value={dimension} onValueChange={handleDimension}>
              <SelectTrigger aria-label="Dimension" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STUB_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
        </Section>
        <Section title="Design">
          <DesignFolder design={design} onChange={handleDesign} />
        </Section>
        <Section title="Engine">
          <RackFolder
            axes={axes}
            dimensionId="dev-harness"
            moduleOptions={MODULE_OPTIONS}
            onModuleChange={handleModuleChange}
            onRangeChange={handleRangeChange}
            onVisualFeedbackChange={handleVisualFeedbackChange}
          />
        </Section>
      </Panel>

      <p style={{ opacity: 0.8, marginTop: 16 }}>
        design/dimension changes: <code data-testid="change-count">{changes}</code>
        {'  ·  '}rack commits: <code data-testid="rack-commits">{rackCommits}</code>
        {'  ·  '}rack live drags: <code data-testid="rack-live">{rackLive}</code>
      </p>
      <pre data-testid="state" style={{ fontSize: 12, opacity: 0.85, background: '#15151c', padding: 12, borderRadius: 6, overflowX: 'auto' }}>
        {JSON.stringify({ dimension, design, rack: axes }, null, 2)}
      </pre>
    </main>
  );
}

const el = document.getElementById('edit-panel-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
