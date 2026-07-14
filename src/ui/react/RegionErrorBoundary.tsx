/**
 * @file src/ui/react/RegionErrorBoundary.tsx
 * @description Isolates a React-owned region (strategy §5) so a runtime error in
 * one region neither blanks the whole `?ui=react` shell nor hides the rest.
 *
 * This is a compatibility-shell (strategy §2.3): the legacy `.ui-overlay` chrome
 * stays mounted UNDERNEATH every React region. So the correct fallback for a
 * crashed region is to render NOTHING — the legacy version of that control shows
 * through, and the app stays usable. The error is logged for diagnosis.
 *
 * Error boundaries must be class components (React has no hook equivalent).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Region name, for the console diagnostic + a hidden DOM marker. */
  region: string;
  children: ReactNode;
}

interface State {
  errored: boolean;
}

export class RegionErrorBoundary extends Component<Props, State> {
  state: State = { errored: false };

  static getDerivedStateFromError(): State {
    return { errored: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[orbiters-react-ui] region "${this.props.region}" crashed; falling back to legacy chrome.`, error, info);
  }

  render(): ReactNode {
    if (this.state.errored) {
      // Render nothing → the legacy region underneath remains usable.
      return <div data-ui-region-error={this.props.region} hidden />;
    }
    return this.props.children;
  }
}
