/**
 * @file src/ui/react/studio/studioMode.ts
 * @description The ONE read of whether the Orbiter Studio is active — the
 * React edit-mode shell that wraps the play UI on the left with the edit panel on the
 * right. React is the only UI, so the Studio simply IS edit mode: it activates whenever
 * the world interaction mode is `edit` (it reserves canvas space + mounts the edit panel).
 *
 * A plain read of the URL — no engine/edit-mode access — so any layer can call it cheaply.
 */
import { getWorldInteractionModeFromUrl } from '../../../utils/urlParams';

export function isStudioEnabled(
  search = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  return getWorldInteractionModeFromUrl(new URLSearchParams(search)) === 'edit';
}
