// Discord inside Linkord (Windows app, lib/discord.ts): the switch beside REC, the way back in the title bar, and the
// stage under Discord's view (its picture during the switch, the introduction while Discord is off).
import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import { closeDiscord, discord, discordAvailable, enableDiscord, openDiscord, retryDiscord } from '../lib/discord';
import { t } from '../lib/i18n';
import { prefs } from '../lib/prefs';
import { anyAlert, totalMentions } from '../lib/store';
import { Back, SiteIcon } from './Icons';
import { Button } from './ui/button';

const DISCORD = 'https://discord.com';

/** The server list's badge: a count for mentions, a dot for other unread messages. */
function SwitchBadge(p: { count: number; alert: boolean }) {
  return (
    <Show
      when={p.count}
      fallback={
        <Show when={p.alert}>
          <span class="badge switch-badge rail-alert" aria-label={t('New messages')}>
            <i />
          </span>
        </Show>
      }
    >
      <span class="badge switch-badge">{p.count > 99 ? '99+' : p.count}</span>
    </Show>
  );
}

/** Beside REC, always there in the Windows app (on or not): to Discord, with Discord's badge. */
export function DiscordButton() {
  return (
    <Show when={discordAvailable}>
      <button
        class="icon-btn discord-btn"
        aria-label="Discord"
        data-tip={t('Discord (Ctrl+Alt+D)')}
        onClick={() => void openDiscord()}
      >
        <SiteIcon url={DISCORD} size={19} />
        <SwitchBadge count={discord.mentions} alert={discord.unread} />
      </button>
    </Show>
  );
}

/** In the title bar while Discord is in front: back to Linkord, with Linkord's badge. A native tooltip (title): the
 *  page's own would open under Discord's view. */
export function DiscordBackButton() {
  return (
    <Show when={discord.mode === 'discord'}>
      <button
        class="titlebar-switch"
        aria-label={t('Back to Linkord')}
        title={t('Back to Linkord (Ctrl+Alt+D)')}
        onClick={() => void closeDiscord()}
      >
        <Back size={15} />
        <span>Linkord</span>
        <SwitchBadge count={totalMentions()} alert={anyAlert()} />
      </button>
    </Show>
  );
}

/** Under Discord's view, below the title bar. */
export function DiscordStage() {
  return (
    <Show when={discord.mode === 'discord'}>
      <div class="discord-stage">
        <Switch>
          <Match when={!prefs.discord.enabled}>
            <DiscordIntro />
          </Match>
          <Match when={discord.shot}>
            <img class="discord-shot" src={discord.shot} alt="" draggable={false} />
          </Match>
          <Match when={true}>
            <Opening />
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

/** Normally covered by Discord's view within a moment; if it isn't after 10 s, a way to ask again. */
function Opening() {
  const [slow, setSlow] = createSignal(false);
  const timer = setTimeout(() => setSlow(true), 10_000);
  onCleanup(() => clearTimeout(timer));
  return (
    <div class="discord-opening">
      <SiteIcon url={DISCORD} size={40} />
      <p class="muted">{t('Opening Discord…')}</p>
      <Show when={slow()}>
        <Button variant="secondary" size="sm" onClick={() => (setSlow(false), retryDiscord())}>
          {t('Try again')}
        </Button>
      </Show>
    </div>
  );
}

function DiscordIntro() {
  return (
    <div class="discord-intro">
      <SiteIcon url={DISCORD} size={44} />
      <h1>{t('Discord, inside Linkord')}</h1>
      <p class="muted">
        {t(
          'Sign in once and Discord opens right here, so the Discord app can stay closed. It runs on the browser engine Linkord already uses, so it takes less memory than the Discord app.',
        )}
      </p>
      <ul>
        <li>{t("Messages, calls, video and screen sharing, with Discord's own notifications and settings.")}</li>
        <li>
          {t(
            'Switch with this button or Ctrl+Alt+D. Discord keeps running in the background; you can change that in Settings.',
          )}
        </li>
        <li>
          {t(
            "Push to talk works only while Discord is in front, and your games don't show as your activity there. Those need the Discord app.",
          )}
        </li>
      </ul>
      <div class="discord-intro-actions">
        <Button onClick={() => void enableDiscord()}>{t('Turn on Discord')}</Button>
        <Button variant="ghost" onClick={() => void closeDiscord()}>
          {t('Not now')}
        </Button>
      </div>
    </div>
  );
}
