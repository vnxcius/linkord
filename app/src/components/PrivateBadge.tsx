import { Show } from 'solid-js';
import { t } from '../lib/i18n';
import { isPrivateChannel } from '../lib/perms';
import * as I from './Icons';

/** Small lock on the top right of a private channel's icon (@everyone can't see it, like Discord's). */
export function PrivateBadge(p: { channelId: string }) {
  return (
    <Show when={isPrivateChannel(p.channelId)}>
      <span class="lock-badge" aria-label={t('Private channel')} data-tip={t('Private channel')}>
        <I.Lock size={9} />
      </span>
    </Show>
  );
}
