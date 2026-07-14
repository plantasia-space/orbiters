/**
 * @file src/input/midi/MidiWidgetDriver.js
 * @description Dispatch helpers that let custom UI widgets react to MIDI learn/feedback events.
 */
export class MidiWidgetDriver {
  static applyToggleWidget(widget, active) {
    if (!widget || typeof widget.dispatchEvent !== 'function') {
      return;
    }
    widget.dispatchEvent(
      new CustomEvent('midi:toggle', {
        detail: { active: Boolean(active) },
      }),
    );
  }

  static updateWebAudioWidget(widget, value, type = 'cc') {
    if (!widget) {
      return;
    }
    if (type === 'cc') {
      const normalizedValue = value / 127;
      const min = widget._min !== undefined ? widget._min : widget.min;
      const max = widget._max !== undefined ? widget._max : widget.max;
      if (min === undefined || max === undefined) {
        console.warn(`Widget '${widget.id}' is missing min/max values.`);
        return;
      }
      widget.value = min + normalizedValue * (max - min);
    } else if (type === 'note') {
      if (widget.type === 'toggle' || widget.hasAttribute?.('data-toggle')) {
        widget.value = value > 0 ? 1 : 0;
      } else {
        const normalizedValue = value / 127;
        const min = widget._min !== undefined ? widget._min : widget.min;
        const max = widget._max !== undefined ? widget._max : widget.max;
        if (min === undefined || max === undefined) {
          console.warn(`Widget '${widget.id}' is missing min/max values.`);
          return;
        }
        widget.value = min + normalizedValue * (max - min);
      }
    }

    if (typeof widget.setValue === 'function') {
      widget.setValue(widget.value, true);
    }
    if (typeof widget.redraw === 'function') {
      widget.redraw();
    }
  }

  static triggerWebAudioSwitch(widget, value) {
    if (!widget) {
      return;
    }
    if (widget.tagName?.toLowerCase() === 'a' && widget.classList?.contains('dropdown-item')) {
      if (typeof widget.onclick === 'function') {
        widget.onclick();
      } else {
        console.warn(`Dropdown item '${widget.id}' has no onclick handler.`);
      }
    } else if (widget.type === 'toggle') {
      widget.setState?.(value > 0 ? 1 : 0, true);
    } else if (widget.type === 'kick') {
      widget.triggerKick?.();
    } else if (widget.type === 'sequential') {
      const delta = value > 64 ? 1 : -1;
      widget.cycleState?.(delta);
    } else if (widget.type === 'radio') {
      widget.activateRadio?.();
    } else {
      widget.setValue?.(value / 127, true);
    }

    if (typeof widget.redraw === 'function') {
      widget.redraw();
    }
  }

  static updateParameterElement(element, midiValue) {
    if (!element) {
      return false;
    }
    if (element.tagName?.toLowerCase() === 'a' && element.classList?.contains('dropdown-item')) {
      if (typeof element.onclick === 'function') {
        element.onclick();
      } else {
        console.warn(`MIDIController: No onclick handler defined for dropdown item '${element.id || element.dataset?.value}'.`);
      }
      return true;
    }

    const normalizedValue = midiValue / 127;
    const minAttr =
      element._min ?? element.min ?? element.getAttribute?.('min');
    const maxAttr =
      element._max ?? element.max ?? element.getAttribute?.('max');
    const min = Number(minAttr);
    const max = Number(maxAttr);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      element.value = min + normalizedValue * (max - min);
    } else if (typeof element.value === 'number') {
      element.value = normalizedValue;
    } else {
      element.value = normalizedValue;
    }

    if (typeof element.setValue === 'function') {
      element.setValue(element.value, true);
    }

    if (window.__DEBUG_MIDI) {
      console.debug('[MidiWidgetDriver] updated element', {
        id: element.id,
        value: element.value,
        min,
        max,
        normalizedValue,
      });
    }

    if (typeof element.dispatchEvent === 'function') {
      element.dispatchEvent(
        new CustomEvent('midi:value', {
          bubbles: true,
          detail: { value: element.value },
        }),
      );
      element.dispatchEvent(
        new Event('input', {
          bubbles: true,
        }),
      );
      element.dispatchEvent(
        new Event('change', {
          bubbles: true,
        }),
      );
    }

    if (typeof element.redraw === 'function') {
      element.redraw();
    }
    return true;
  }
}
