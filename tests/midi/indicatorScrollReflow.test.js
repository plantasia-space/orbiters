// @vitest-environment jsdom
/**
 * MIDI-learn CH/CC badge (`MidiIndicatorManager`) scroll behaviour.
 *
 * Regression guard for the bug where, in a scrolling host (the embedded Feed), the position:fixed
 * badges froze at the top of the screen while the orbiter scrolled away. The badges must reflow on
 * scroll/resize (only while shown), stay glued to their on-screen widget, and HIDE — not clamp to
 * the top edge — once the widget scrolls out of the viewport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MidiIndicatorManager } from '../../src/ui/midi/MidiIndicatorManager.js';

function makeWidget(id, rect) {
  const el = document.createElement('div');
  el.id = id;
  el.getBoundingClientRect = () => ({
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    ...rect,
  });
  document.body.appendChild(el);
  return el;
}

const onScreen = { left: 100, right: 200, top: 300, bottom: 320 };
const aboveViewport = { left: 100, right: 200, top: -80, bottom: -60 };

describe('MidiIndicatorManager scroll reflow', () => {
  let mgr;
  let addSpy;
  let removeSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
    mgr = new MidiIndicatorManager();
  });

  afterEach(() => {
    mgr.clear();
    vi.restoreAllMocks();
  });

  it('binds a capturing scroll listener only while the badges are shown', () => {
    makeWidget('w1', onScreen);
    mgr.markAsMapped('w1', { midiCC: 5, midiChannel: 1 });

    mgr.setVisibility(true);
    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    mgr.setVisibility(false);
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('does not bind the scroll listener twice when shown repeatedly', () => {
    makeWidget('w1', onScreen);
    mgr.markAsMapped('w1', { midiCC: 5, midiChannel: 1 });
    mgr.setVisibility(true);
    const scrollBinds = addSpy.mock.calls.filter(([type]) => type === 'scroll').length;
    mgr.setVisibility(true);
    expect(addSpy.mock.calls.filter(([type]) => type === 'scroll').length).toBe(scrollBinds);
  });

  it('shows a badge glued to an on-screen widget, fixed to the viewport', () => {
    makeWidget('w1', onScreen);
    const badge = mgr.markAsMapped('w1', { midiCC: 5, midiChannel: 1 });
    mgr.setVisibility(true);
    expect(badge.style.display).toBe('block');
    expect(badge.style.position).toBe('fixed');
  });

  it('hides the badge — never pins it to the top — when the widget scrolls out of view', () => {
    const widget = makeWidget('w1', onScreen);
    const badge = mgr.markAsMapped('w1', { midiCC: 5, midiChannel: 1 });
    mgr.setVisibility(true);
    expect(badge.style.display).toBe('block');

    // Simulate the widget scrolling above the top of the viewport, then a scroll event.
    widget.getBoundingClientRect = () => ({
      width: 100, height: 20, x: 100, y: -80, ...aboveViewport,
    });
    mgr.refreshPositions();

    expect(badge.style.display).toBe('none');
    expect(badge.style.top).not.toBe('0px'); // must not clamp-and-pin to the top edge
  });

  it('re-shows the badge when the widget scrolls back into view', () => {
    const widget = makeWidget('w1', onScreen);
    const badge = mgr.markAsMapped('w1', { midiCC: 5, midiChannel: 1 });
    mgr.setVisibility(true);

    widget.getBoundingClientRect = () => ({ width: 100, height: 20, x: 100, y: -80, ...aboveViewport });
    mgr.refreshPositions();
    expect(badge.style.display).toBe('none');

    widget.getBoundingClientRect = () => ({ width: 100, height: 20, x: 100, y: 300, ...onScreen });
    mgr.refreshPositions();
    expect(badge.style.display).toBe('block');
  });
});
