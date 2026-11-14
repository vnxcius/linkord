// On phones (web): offers notifications once (lib/push.ts), at the top of the dock (Sidebar.tsx Dock). On an iPhone that hasn't added Pottira to the Home Screen
// it explains that first, since Safari only allows notifications there. Dismissed per device.
import { createSignal, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { enablePush, pushState } from '../lib/push';
import { state } from '../lib/store';
import { isMobile, toast } from '../lib/ui';
import * as I from './Icons';

const KEY = 'linkord.pushBannerDismissed';

function dismissed() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function PushBanner() {
  const [hidden, setHidden] = createSignal(dismissed());
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {}
  };
  const turnOn = async () => {
    try {
      if (await enablePush()) {
        toast(t('Notifications are on for this phone.'));
        close();
      } else if (pushState() === 'blocked')
        toast(t('Notifications are blocked for this site in your browser settings.'), 6000);
    } catch {
      toast(t("Couldn't turn notifications on. Try again from Settings → Notifications."), 6000);
    }
  };
  return (
    <Show when={state.ready && isMobile() && !hidden() && (pushState() === 'off' || pushState() === 'install')}>
      <div class="push-banner" role="status">
        <span class="push-banner-text">
          {pushState() === 'install'
            ? t(
                'To get notifications on this phone, add Pottira to your Home Screen: tap Share, then Add to Home Screen.',
              )
            : t('Get notifications on this phone for DMs and mentions.')}
        </span>
        <Show when={pushState() === 'off'}>
          <button class="btn small-btn primary" onClick={() => void turnOn()}>
            {t('Turn on')}
          </button>
        </Show>
        <button class="push-banner-close" aria-label={t('Dismiss')} onClick={close}>
          <I.Close size={16} />
        </button>
      </div>
    </Show>
  );
}
