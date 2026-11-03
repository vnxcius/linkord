// "Click outside to close": the listener starts a moment later, so the click that opened something doesn't close it. The
// timer is cancelled on cleanup: something closed before it fired (Escape right after opening, on a busy main thread) used
// to attach its listener anyway and keep it forever, and that closed every later right-click menu as soon as it was pressed.
import { onCleanup } from 'solid-js';

/** Call while the component is being set up or from onMount. */
export function onOutsideMouseDown(handler: (e: MouseEvent) => void) {
  const timer = setTimeout(() => document.addEventListener('mousedown', handler));
  onCleanup(() => {
    clearTimeout(timer);
    document.removeEventListener('mousedown', handler);
  });
}
