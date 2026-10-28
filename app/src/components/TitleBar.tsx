import { Show } from 'solid-js';
import { t } from '../lib/i18n';
import { isTauri, windowControl } from '../lib/platform';
import { state } from '../lib/store';
import { Close, Emblem, Maximize, Minimize } from './Icons';

/** Graphite's title bar: the Triforce and where you are, centered. On the desktop app it is also the window
 *  chrome (the native title bar is disabled); on the web it's only shown on wide screens. */
export function TitleBar() {
  const place = () => (!state.ready ? 'Linkord' : state.view === '@me' ? t('Direct Messages') : (state.guilds[state.view]?.name ?? 'Linkord'));
  return (
    <div class="titlebar" classList={{ web: !isTauri }} data-tauri-drag-region>
      <span class="titlebar-side" data-tauri-drag-region>
        <Show when={state.connection === 'reconnecting'}>
          <span class="titlebar-status">{t('Reconnecting…')}</span>
        </Show>
      </span>
      <span class="titlebar-place" data-tauri-drag-region>
        <Emblem size={14} />
        <span data-tauri-drag-region>{place()}</span>
      </span>
      <span class="titlebar-side right" data-tauri-drag-region>
        <Show when={isTauri}>
          <span class="titlebar-controls">
            <button aria-label={t('Minimize')} onClick={() => void windowControl('minimize')}>
              <Minimize size={14} />
            </button>
            <button aria-label={t('Maximize')} onClick={() => void windowControl('toggleMaximize')}>
              <Maximize size={12} />
            </button>
            <button aria-label={t('Close')} class="close" onClick={() => void windowControl('close')}>
              <Close size={14} />
            </button>
          </span>
        </Show>
      </span>
    </div>
  );
}
