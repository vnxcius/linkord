// Full-window pages over the app: the desktop app's download page (web only, /download) and the patch notes
// (/changelog on the web, also in the desktop app). Plus the two banners that lead to them: "get the desktop
// app" (web, dismissable) and "Linkord was updated" (once per new version).
import {
  createEffect,
  on,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import { api } from '../lib/api';
import { dateLocale, msg, t } from '../lib/i18n';
import { isTauri } from '../lib/platform';
import { prefs, setPrefs } from '../lib/prefs';
import { closePage, openPage, page } from '../lib/route';
import { isMobile } from '../lib/ui';
import * as I from './Icons';
import { Emblem } from './Icons';
import { DesktopMock, PhoneMock } from './DownloadArt';
import { OverlayArt, RecArt, StudioArt } from './ReleaseArt';

interface Download {
  version: string;
  url: string;
  size?: number | null;
  date?: string | null;
  notes?: string;
}
type Downloads = Partial<Record<'windows' | 'deb' | 'rpm' | 'android', Download>>;

interface Release {
  version: string;
  date?: string | null;
  notes: string;
}

const ua = navigator.userAgent;
/** The visitor's platform, to put the right download first. */
const os: 'windows' | 'linux' | 'mac' | 'mobile' | 'other' = /Android|iPhone|iPad|iPod/.test(ua)
  ? 'mobile'
  : /Windows/.test(ua)
    ? 'windows'
    : /Macintosh|Mac OS X/.test(ua)
      ? 'mac'
      : /Linux|X11|CrOS/.test(ua)
        ? 'linux'
        : 'other';

// Fetched once per page load; the banner and the page share it.
const [downloads, setDownloads] = createSignal<Downloads | null>(null);
let loading: Promise<void> | null = null;
function loadDownloads() {
  loading ??= api<Downloads>('GET', '/downloads')
    .then((d) => void setDownloads(d))
    .catch(() => {
      loading = null;
    });
}

const megabytes = (n?: number | null) => (n ? `${(n / 1048576).toFixed(1)} MB` : '');
const longDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric' }) : '';
/** Patch notes are one change per line (a leading "- " is fine). */
const lines = (notes: string) =>
  notes
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const markSeen = () => setPrefs({ lastSeenVersion: __APP_VERSION__ });

/** Whichever page is open. */
export function PageHost() {
  // One frame for every page: switching pages swaps only its content, so the app never shows through.
  return (
    <Show when={page()}>
      <PageShell>
        <Switch>
          <Match when={page() === 'download' && !isTauri}>
            <DownloadPage />
          </Match>
          <Match when={page() === 'changelog'}>
            <PatchNotesPage />
          </Match>
        </Switch>
      </PageShell>
    </Show>
  );
}

function PageShell(p: { children: JSX.Element }) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && closePage();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  let main!: HTMLElement;
  createEffect(on(page, () => main.scrollTo(0, 0), { defer: true }));
  return (
    <div class="site-page" role="dialog">
      <header class="site-nav">
        <button class="site-brand" onClick={closePage}>
          <Emblem size={24} />
          <span>Linkord</span>
        </button>
        <nav class="site-links">
          <Show when={!isTauri}>
            <button classList={{ active: page() === 'download' }} onClick={() => openPage('download')}>
              {t('Download')}
            </button>
          </Show>
          <button classList={{ active: page() === 'changelog' }} onClick={() => openPage('changelog')}>
            {t('Patch notes')}
          </button>
        </nav>
        <button class="btn site-back" onClick={closePage}>
          <I.Back size={16} />
          <span>{t('Back to Linkord')}</span>
        </button>
      </header>
      <main class="site-main" ref={main}>
        {p.children}
      </main>
    </div>
  );
}

/** What the desktop app adds over the browser. `windows`: only the Windows app does it (tagged for everyone else). */
const DESKTOP: { title: string; text: string; windows?: boolean }[] = [
  {
    title: msg('Push to talk inside games'),
    text: msg('Keybinds keep working while a game has focus, with Linkord minimized or in the tray.'),
    windows: true,
  },
  {
    title: msg('Streams with sound'),
    text: msg(
      "Native screen capture, hardware encoded. On Windows 11 it sends only the shared app's sound, never your calls.",
    ),
  },
  {
    title: msg('Voice overlay'),
    text: msg('See who is talking over a borderless game. It never shows up in your stream or your recordings.'),
    windows: true,
  },
  {
    title: msg("Shows what you're playing"),
    text: msg('Friends see your game and how long you have been at it. One click goes live with its window.'),
    windows: true,
  },
  {
    title: msg('League of Legends, built in'),
    text: msg('Your lobby, queue and champion on your card, and friends join your lobby from Linkord.'),
    windows: true,
  },
  {
    title: msg('Small, and always there'),
    text: msg(
      'A few megabytes on Tauri, not a whole browser. Starts with your computer, waits in the tray and updates itself.',
    ),
  },
];

/** The REC points beside its scene. */
const REC_POINTS = [
  { icon: I.Rec, text: msg('Every game you play, recorded in the background, with nothing on your screen.') },
  {
    icon: I.Scissors,
    text: msg('One key saves the last seconds as a clip; others take a screenshot or mark the moment.'),
  },
  { icon: I.Film, text: msg('A studio for hours-long sessions: skim, jump between moments, cut a clip instantly.') },
  { icon: I.Link, text: msg('Share a clip with a link that anyone can watch, even without an account.') },
];

/** What the Android app is about, beside the phone. */
const MOBILE_POINTS = [
  { icon: I.Phone, text: msg('Calls ring like a phone call, even with the app closed.') },
  { icon: I.Mic, text: msg('Voice messages: hold to record, slide to cancel.') },
  { icon: I.Tv, text: msg('Watch streams and videos with your friends.') },
];

const onAndroid = /Android/.test(ua);

/** A file's name from its download URL: what the terminal commands install. */
const fileName = (d?: Download) => (d ? decodeURIComponent(d.url.split('/').pop() ?? '') : '');
const meta = (f: Download, platform?: string) =>
  [platform, t('Version {version}', { version: f.version }), megabytes(f.size)].filter(Boolean).join(' · ');

function DownloadPage() {
  onMount(loadDownloads);
  // A shared link to a section (/download#android, #platforms): the page scrolls in its own container and draws its
  // sections once the downloads are in, so scroll there ourselves, once, when it exists.
  const target = location.hash.slice(1);
  if (target) {
    createEffect(
      on(downloads, (d) => {
        if (d) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
      }),
    );
  }
  const win = () => downloads()?.windows;
  const deb = () => downloads()?.deb;
  const rpm = () => downloads()?.rpm;
  const linux = () => rpm() ?? deb();
  const latest = () => win() ?? linux();
  const android = () => downloads()?.android;
  const none = () => downloads() && !win() && !linux() && !(onAndroid && android());
  const onLinux = os === 'linux';

  return (
    <div class="dl">
      <section class="dl-hero">
        <div class="dl-hero-text">
          <p class="showcase-kicker">{onAndroid && android() ? t('Linkord for Android') : t('Linkord for desktop')}</p>
          <h1>{t('Talk, stream, play. And now, record.')}</h1>
          <p class="dl-lead">
            {t(
              'Voice with zero setup, push to talk inside games and streams with sound. New in 2.0: REC records your games, and the best moments are one key away.',
            )}
          </p>
          <Show when={downloads()} fallback={<div class="spinner" />}>
            <Show when={!none()} fallback={<p class="muted">{t('No downloads are available yet.')}</p>}>
              <PrimaryDownload win={win()} deb={deb()} rpm={rpm()} android={android()} />
            </Show>
          </Show>
          <Show when={latest()}>
            {(l) => (
              <button class="dl-whats-new" onClick={() => openPage('changelog')}>
                <span class="tag">{t('New')}</span>
                {t("What's new in {version}", { version: l().version })}
                <I.Chevron size={14} />
              </button>
            )}
          </Show>
        </div>
        <div class="dl-window">
          <DesktopMock />
        </div>
      </section>

      {/* An Android phone sees its app first, the desktop pitch after. */}
      <Show when={onAndroid}>
        <MobileSection android={android()} />
      </Show>

      <section class="dl-rec">
        <div class="dl-rec-text">
          <p class="dl-rec-kicker">
            <span class="release-rec-tag">
              <i /> REC
            </span>
            {t('New in 2.0')}
          </p>
          <h2>{t('Your games, recorded while you play')}</h2>
          <ul class="dl-rec-points">
            <For each={REC_POINTS}>
              {(p) => (
                <li>
                  <p.icon size={18} />
                  <span>{t(p.text)}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="dl-fine">
            {t(
              'Windows app. Nothing records until you turn REC on, recordings stay on your PC, and friends can keep their voice out of yours.',
            )}
          </p>
        </div>
        <div class="release-shot release-art dl-scene dl-scene-main">
          <RecArt />
        </div>
        <div class="dl-rec-row">
          <figure class="dl-rec-more">
            <div class="release-shot release-art dl-scene">
              <StudioArt />
            </div>
            <figcaption>
              <strong>{t('The studio')}</strong>
              <span>{t('Thumbnails, moments and a cut that takes no time, even on a three-hour session.')}</span>
            </figcaption>
          </figure>
          <figure class="dl-rec-more">
            <div class="release-shot release-art dl-scene">
              <OverlayArt />
            </div>
            <figcaption>
              <strong>{t('Over your game')}</strong>
              <span>{t('Clip, screenshot and your latest clips without leaving the match.')}</span>
            </figcaption>
          </figure>
        </div>
      </section>

      <Show when={!onAndroid}>
        <MobileSection android={android()} />
      </Show>

      <section class="dl-section">
        <div class="dl-section-head">
          <h2>{t('Made for the desktop')}</h2>
          <p class="dl-lead">{t('Everything in the browser, plus what only an app on your computer can do.')}</p>
        </div>
        <ol class="dl-toc">
          <For each={DESKTOP}>
            {(f, i) => (
              <li>
                <span class="dl-toc-num">{String(i() + 1).padStart(2, '0')}</span>
                <div>
                  <strong>
                    {t(f.title)}
                    <Show when={f.windows && os !== 'windows'}>
                      <span class="release-tag">{t('Windows app')}</span>
                    </Show>
                  </strong>
                  <p>{t(f.text)}</p>
                </div>
              </li>
            )}
          </For>
        </ol>
      </section>

      <section class="dl-section" id="platforms">
        <div class="dl-section-head">
          <h2>{t('Every platform')}</h2>
        </div>
        <div class="dl-platforms">
          <div class="dl-platform" classList={{ mine: os === 'windows' }}>
            <div class="dl-platform-head">
              <WindowsMark />
              <strong>Windows</strong>
              <Show when={os === 'windows'}>
                <span class="tag">{t('Your computer')}</span>
              </Show>
            </div>
            <p class="muted">
              {t(
                'Windows 10 and 11, 64-bit. Everything Linkord does, REC included. App-only stream sound needs Windows 11.',
              )}
            </p>
            <Show when={win()} fallback={<p class="muted small">{t('Not available yet.')}</p>}>
              {(f) => (
                <>
                  <a class="btn primary" href={f().url} download="">
                    <I.Download size={16} /> {t('Download')}
                  </a>
                  <span class="dl-meta">{meta(f())}</span>
                </>
              )}
            </Show>
          </div>
          <div class="dl-platform" classList={{ mine: onLinux }}>
            <div class="dl-platform-head">
              <LinuxMark />
              <strong>Linux</strong>
              <Show when={onLinux}>
                <span class="tag">{t('Your computer')}</span>
              </Show>
            </div>
            <p class="muted">
              {t(
                '64-bit .deb (Debian, Ubuntu, Mint) or .rpm (Fedora, openSUSE). Voice, video and streaming; no REC, overlay or global keybinds yet.',
              )}
            </p>
            <Show when={linux()} fallback={<p class="muted small">{t('Not available yet.')}</p>}>
              {(f) => (
                <>
                  <div class="row">
                    <Show when={deb()}>
                      {(d) => (
                        <a class="btn primary" href={d().url} download="">
                          <I.Download size={16} /> .deb
                        </a>
                      )}
                    </Show>
                    <Show when={rpm()}>
                      {(r) => (
                        <a class="btn" href={r().url} download="">
                          <I.Download size={16} /> .rpm
                        </a>
                      )}
                    </Show>
                  </div>
                  <span class="dl-meta">{meta(f())}</span>
                </>
              )}
            </Show>
          </div>
          <Show when={downloads()?.android}>
            {(a) => (
              <div class="dl-platform" classList={{ mine: /Android/.test(ua) }}>
                <div class="dl-platform-head">
                  <I.MobileDevice size={20} />
                  <strong>{t('Android')}</strong>
                </div>
                <p class="muted">
                  {t(
                    'The Linkord app for Android phones. Allow your browser to install apps when Android asks; it updates itself after that.',
                  )}
                </p>
                <div class="row">
                  <a class="btn primary" href={a().url} download="">
                    <I.Download size={16} /> .apk
                  </a>
                </div>
                <span class="dl-meta">{meta(a())}</span>
              </div>
            )}
          </Show>
          <div class="dl-platform" classList={{ mine: os === 'mac' || os === 'mobile' }}>
            <div class="dl-platform-head">
              <I.MobileDevice size={20} />
              <strong>{t('Browser and phone')}</strong>
            </div>
            <p class="muted">
              {t(
                'On a Mac, a phone or anywhere else, Linkord runs in the browser with voice, video and screen sharing. Add it to your home screen for notifications.',
              )}
            </p>
            <button class="btn" onClick={closePage}>
              {t('Open Linkord')}
            </button>
          </div>
        </div>
      </section>

      <section class="dl-section">
        <div class="dl-section-head">
          <h2>{onLinux ? t('Installing on Linux') : t('Installing on Windows')}</h2>
        </div>
        <ol class="dl-steps">
          <Show
            when={onLinux}
            fallback={
              <>
                <li>
                  <strong>{t('Run the installer')}</strong>
                  <p>{t('Open the file you downloaded. It installs for your user only, no administrator needed.')}</p>
                </li>
                <li>
                  <strong>{t('If Windows warns you')}</strong>
                  <p>
                    {t(
                      'SmartScreen may say it protected your PC because the installer is new. Click More info, then Run anyway.',
                    )}
                  </p>
                </li>
              </>
            }
          >
            <li>
              <strong>{t('Install the package')}</strong>
              <p>{t('Open it with your software center, or in a terminal:')}</p>
              <Show when={deb()}>
                <code class="dl-code">sudo apt install ./{fileName(deb())}</code>
              </Show>
              <Show when={rpm()}>
                <code class="dl-code">sudo dnf install ./{fileName(rpm())}</code>
              </Show>
            </li>
            <li>
              <strong>{t('Updates')}</strong>
              <p>{t('Linkord asks for your password when an update is ready, then installs it.')}</p>
            </li>
          </Show>
          <li>
            <strong>{t('Sign in with Discord')}</strong>
            <p>{t('The app opens your browser to sign in, then picks up where you left off.')}</p>
          </li>
        </ol>
      </section>

      <footer class="dl-foot">
        <Emblem size={36} />
        <strong>Linkord</strong>
        <span class="grow" />
        <button class="btn ghost" onClick={() => openPage('changelog')}>
          {t('Patch notes')}
        </button>
        <button class="btn" onClick={closePage}>
          {t('Open Linkord')}
        </button>
      </footer>
    </div>
  );
}

/** The big button for this computer (both Linux packages on Linux; Windows anywhere else). */
/** Linkord for Android: what the app does, the APK (once one is published), install steps and the phone. */
function MobileSection(p: { android?: Download }) {
  return (
    <section class="dl-mobile" id="android">
      <div class="dl-mobile-text">
        <p class="showcase-kicker">{t('Linkord for Android')}</p>
        <h2>{t('Linkord on your phone')}</h2>
        <ul class="dl-rec-points">
          <For each={MOBILE_POINTS}>
            {(p) => (
              <li>
                <p.icon size={18} />
                <span>{t(p.text)}</span>
              </li>
            )}
          </For>
        </ul>
        <div class="dl-mobile-get">
          <Show
            when={p.android}
            fallback={
              <p class="muted">{t("The Android app is coming soon. Linkord already works in your phone's browser.")}</p>
            }
          >
            {(a) => (
              <>
                <a class="btn dl-big" classList={{ primary: onAndroid }} href={a().url} download="">
                  <I.MobileDevice size={18} />
                  {t('Download for Android')}
                </a>
                <span class="dl-meta">{meta(a(), 'Android 10+')}</span>
                <Show when={!onAndroid}>
                  <p class="dl-fine">{t('On a computer? Open this page on your phone.')}</p>
                </Show>
              </>
            )}
          </Show>
          <p class="dl-fine">{t('No iPhone app yet. In Safari, add Linkord to your Home Screen.')}</p>
        </div>
      </div>
      <div class="dl-mobile-phone">
        <PhoneMock />
      </div>
      <Show when={p.android}>
        <ol class="dl-steps dl-mobile-steps">
          <li>
            <strong>{t('Download')}</strong>
            <p>{t('Open this page on your phone and tap Download for Android.')}</p>
          </li>
          <li>
            <strong>{t('Install')}</strong>
            <p>{t('Let your browser install apps when Android asks.')}</p>
          </li>
          <li>
            <strong>{t('Sign in with Discord')}</strong>
            <p>{t('Updates install from inside the app.')}</p>
          </li>
        </ol>
      </Show>
    </section>
  );
}

function PrimaryDownload(p: { win?: Download; deb?: Download; rpm?: Download; android?: Download }) {
  // On an Android phone the app for it comes first; the desktop downloads stay below on the page.
  if (onAndroid && p.android) {
    const a = p.android;
    return (
      <div class="dl-primary">
        <a class="btn primary dl-big" href={a.url} download="">
          <I.MobileDevice size={18} />
          {t('Download for Android')}
        </a>
        <span class="dl-meta">{meta(a, 'Android 10+')}</span>
      </div>
    );
  }
  return (
    <div class="dl-primary">
      <Show
        when={os === 'linux' && (p.deb || p.rpm)}
        fallback={
          <Show when={p.win}>
            {(f) => (
              <>
                <a class="btn primary dl-big" href={f().url} download="">
                  <WindowsMark />
                  {t('Download for Windows')}
                </a>
                <span class="dl-meta">{meta(f(), 'Windows 10/11')}</span>
              </>
            )}
          </Show>
        }
      >
        <div class="row">
          <Show when={p.deb}>
            {(f) => (
              <a class="btn primary dl-big" href={f().url} download="">
                <LinuxMark />
                {t('Download .deb')}
              </a>
            )}
          </Show>
          <Show when={p.rpm}>
            {(f) => (
              <a class="btn dl-big" href={f().url} download="">
                {t('Download .rpm')}
              </a>
            )}
          </Show>
        </div>
        <span class="dl-meta">{meta((p.deb ?? p.rpm)!, 'Linux x64')}</span>
      </Show>
      <Show when={os !== 'windows' && os !== 'linux'}>
        <p class="muted small">
          {t('The desktop app is for Windows and Linux. On this device, Linkord works right in the browser.')}
        </p>
      </Show>
    </div>
  );
}

function PatchNotesPage() {
  const [releases] = createResource(() => api<Release[]>('GET', '/changelog'));
  onMount(markSeen);
  return (
    <>
      <section class="notes-head">
        <p class="showcase-kicker">{t('Changelog')}</p>
        <h1>{t('Patch notes')}</h1>
        <p class="dl-lead">
          {t(
            'What changed in Linkord, newest first. The desktop app updates itself; the web app is always on the latest version.',
          )}
        </p>
      </section>
      <Show when={!releases.loading} fallback={<div class="spinner" />}>
        <Show when={releases()?.length} fallback={<p class="muted">{t('No patch notes yet.')}</p>}>
          <ol class="notes-list">
            <For each={releases()}>
              {(r, i) => (
                <li class="notes-release" classList={{ latest: i() === 0 }}>
                  <div class="notes-meta">
                    <span class="notes-version">{r.version}</span>
                    <Show when={r.date}>
                      <time>{longDate(r.date)}</time>
                    </Show>
                    <Show when={i() === 0}>
                      <span class="tag">{t('Latest')}</span>
                    </Show>
                    <Show when={r.version === __APP_VERSION__}>
                      <span class="tag plain">{t('Your version')}</span>
                    </Show>
                  </div>
                  <ul class="notes-changes">
                    <For each={lines(r.notes)}>{(l) => <li>{l}</li>}</For>
                  </ul>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </>
  );
}

/** Web: "get the desktop app", across the top until dismissed (per device). */
export function DownloadBanner() {
  const available = () =>
    os === 'windows' ? downloads()?.windows : os === 'linux' ? (downloads()?.deb ?? downloads()?.rpm) : undefined;
  const wanted = () =>
    !isTauri && !isMobile() && !prefs.downloadBannerDismissed && (os === 'windows' || os === 'linux');
  createEffect(() => wanted() && loadDownloads());
  return (
    <Show when={wanted() && available()}>
      <div class="download-banner" role="region" aria-label={t('Get the desktop app')}>
        <Emblem size={16} />
        <span>
          <strong>{t('Get the desktop app')}</strong>
          <span class="download-banner-pitch">
            {' '}
            — {t('record your games, push to talk inside them and stream with sound.')}
          </span>
        </span>
        <button class="download-banner-btn" onClick={() => openPage('download')}>
          {t('Download')}
        </button>
        <button
          class="download-banner-close"
          aria-label={t('Dismiss')}
          data-tip={t('Dismiss')}
          onClick={() => setPrefs({ downloadBannerDismissed: true })}
        >
          <I.Close size={16} />
        </button>
      </div>
    </Show>
  );
}

/** The app for the device this page is open on (web only), when there's a build of it to download. */
export function appForThisDevice(): { platform: 'windows' | 'linux' | 'android'; file: Download } | null {
  const d = downloads();
  if (isTauri || !d) return null;
  if (onAndroid) return d.android ? { platform: 'android', file: d.android } : null;
  if (os === 'windows' && d.windows) return { platform: 'windows', file: d.windows };
  const linux = d.deb ?? d.rpm;
  if (os === 'linux' && linux) return { platform: 'linux', file: linux };
  return null;
}

export { loadDownloads };

/** What the sign-in screen says about each app: one reason that matters on that device. */
const OFFER = {
  windows: {
    name: msg('Linkord for Windows'),
    pitch: msg('Push to talk works inside games, and REC saves your best plays.'),
    cta: msg('Download for Windows'),
  },
  linux: {
    name: msg('Linkord for Linux'),
    pitch: msg('Voice and screen sharing with sound, in a window of its own.'),
    cta: msg('Download for Linux'),
  },
  android: {
    name: msg('Linkord for Android'),
    pitch: msg('Calls ring like a phone call, even with the app closed.'),
    cta: msg('Download for Android'),
  },
};

/**
 * The sign-in screen's offer (web): the app for this device, ahead of signing in here. One download click (Linux opens
 * the page, to pick .deb or .rpm), and the facts that make it an easy yes: free, its size, it updates itself.
 */
export function AppOffer(p: { platform: 'windows' | 'linux' | 'android'; file: Download }) {
  const o = OFFER[p.platform];
  const icon = () =>
    p.platform === 'windows' ? <WindowsMark /> : p.platform === 'linux' ? <LinuxMark /> : <I.MobileDevice size={18} />;
  return (
    <div class="app-offer">
      <span class="app-offer-badge">{t('Recommended')}</span>
      <div class="app-offer-head">
        <Emblem size={34} />
        <div>
          <strong>{t(o.name)}</strong>
          <span>{[t('Free'), megabytes(p.file.size), t('Updates itself')].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <p>{t(o.pitch)}</p>
      <Show
        when={p.platform !== 'linux'}
        fallback={
          <button class="btn primary app-offer-cta" onClick={() => openPage('download')}>
            {icon()}
            {t(o.cta)}
          </button>
        }
      >
        <a class="btn primary app-offer-cta" href={p.file.url} download="">
          {icon()}
          {t(o.cta)}
        </a>
      </Show>
    </div>
  );
}

/** After an update (desktop) or a new release (web): once, with a link to the patch notes. */
export function UpdatedBanner() {
  // First run on this device: nothing to announce.
  if (!prefs.lastSeenVersion || !prefs.updateBanner) markSeen();
  return (
    <Show when={prefs.updateBanner && prefs.lastSeenVersion && cmpVersion(__APP_VERSION__, prefs.lastSeenVersion) > 0}>
      <div class="update-banner">
        <span>{t('Linkord was updated to {version}.', { version: __APP_VERSION__ })}</span>
        <button class="btn primary small-btn" onClick={() => openPage('changelog')}>
          {t("See what's new")}
        </button>
        <button class="icon-btn tiny" aria-label={t('Dismiss')} onClick={markSeen}>
          <I.Close size={14} />
        </button>
      </div>
    </Show>
  );
}

function WindowsMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 2.2 6.5 1.3v6.3H0zM7.3 1.2 16 0v7.6H7.3zM0 8.4h6.5v6.3L0 13.8zM7.3 8.4H16V16l-8.7-1.2z" />
    </svg>
  );
}

/** A simple penguin-free mark for Linux: a terminal prompt. */
function LinuxMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m5 7 5 5-5 5M12 17h7" />
    </svg>
  );
}
