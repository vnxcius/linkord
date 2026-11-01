// Every file people uploaded, whatever it was uploaded as. Files come straight off the disk through the monitor; only
// what's on screen loads. Removing one goes through the app, so it disappears from everyone's screen too.
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api, bytes, count, dateTime, date, type J, route } from '../lib';
import { Notice, Page } from '../ui';

const CLASSES = [
  { id: '', label: 'Everything' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'file', label: 'Files' },
];
const SOURCES: Record<string, string> = {
  attachment: 'Message attachments',
  avatar: 'Profile pictures',
  banner: 'Profile banners',
  server_icon: 'Server icons',
  server_banner: 'Server banners',
  member_avatar: 'Server profile pictures',
  member_banner: 'Server profile banners',
  emoji: 'Custom emoji',
  sound: 'Soundboard sounds',
  profile_song: 'Profile songs',
};
const SINGULAR: Record<string, string> = {
  attachment: 'Attachment',
  avatar: 'Profile picture',
  banner: 'Profile banner',
  server_icon: 'Server icon',
  server_banner: 'Server banner',
  member_avatar: 'Server profile picture',
  member_banner: 'Server profile banner',
  emoji: 'Custom emoji',
  sound: 'Soundboard sound',
  profile_song: 'Profile song',
};
const PAGE = 60;

const where = (m: J) => {
  if (m.is_dm) return 'Direct message';
  if (m.server && m.channel) return `${m.server}, #${m.channel}`;
  if (m.server) return m.server;
  return 'Their profile';
};

const whatRemovalDoes = (m: J) => {
  switch (m.kind) {
    case 'attachment':
      return "The file goes from the message and from any forward of it, for everyone, right away. A message with nothing else in it is deleted. The rest of the message stays.";
    case 'avatar':
    case 'member_avatar':
      return 'If it is in use, they go back to no picture. They can upload another.';
    case 'emoji':
      return 'The emoji goes from the server. Messages that used it show its name instead.';
    case 'sound':
      return 'The sound goes from the server\'s soundboard.';
    case 'profile_song':
      return 'The song goes from their profile.';
    default:
      return 'It goes away for everyone, right away.';
  }
};

/** A placeholder until scrolled to: long lists never load every file. */
function Thumb(p: { item: J; blur: boolean }) {
  const [visible, setVisible] = createSignal(false);
  let el!: HTMLDivElement;
  onMount(() => {
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
  const [broken, setBroken] = createSignal(false);
  return (
    <div class="thumb" classList={{ blurred: p.blur }} ref={el}>
      <Show when={p.item.missing || broken()}>
        <span class="thumb-kind">File not on disk</span>
      </Show>
      <Show when={!p.item.missing && !broken() && visible()}>
        <Show when={p.item.class === 'image'}>
          <img src={p.item.file} alt="" loading="lazy" onError={() => setBroken(true)} />
        </Show>
        <Show when={p.item.class === 'video'}>
          {/* The first frame only; nothing plays or downloads in full until it's opened. */}
          <video src={`${p.item.file}#t=0.1`} preload="metadata" muted onError={() => setBroken(true)} />
          <span class="thumb-badge">Video</span>
        </Show>
        <Show when={p.item.class === 'audio'}>
          <span class="thumb-kind">Audio</span>
        </Show>
        <Show when={p.item.class === 'file'}>
          <span class="thumb-kind mono">{p.item.filename.split('.').pop()?.slice(0, 6)?.toUpperCase() || 'FILE'}</span>
        </Show>
      </Show>
    </div>
  );
}

function Viewer(p: { item: J; onClose: () => void; onRemoved: (m: J) => void; hasPrev: boolean; hasNext: boolean; onStep: (dir: number) => void }) {
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  // A new item: back to the first step.
  createEffect(
    on(
      () => p.item.url,
      () => {
        setConfirming(false);
        setError('');
      },
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') p.onClose();
    if (confirming()) return;
    if (e.key === 'ArrowLeft' && p.hasPrev) p.onStep(-1);
    if (e.key === 'ArrowRight' && p.hasNext) p.onStep(1);
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      const m = p.item;
      await api('POST', '/moderation/media/remove', { kind: m.kind, url: m.url, item_id: m.item_id, user_id: m.user_id, guild_id: m.guild_id });
      p.onRemoved(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'It could not be removed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="viewer" role="dialog" aria-modal="true" aria-label={p.item.filename} onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="viewer-stage" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
        <Show when={p.item.missing} fallback={
          <>
            <Show when={p.item.class === 'image'}>
              <img src={p.item.file} alt={p.item.filename} />
            </Show>
            <Show when={p.item.class === 'video'}>
              <video src={p.item.file} controls preload="metadata" />
            </Show>
            <Show when={p.item.class === 'audio'}>
              <audio src={p.item.file} controls preload="metadata" />
            </Show>
            <Show when={p.item.class === 'file'}>
              <p class="viewer-note">This type of file doesn't open here. Download it to look at it.</p>
            </Show>
          </>
        }>
          <p class="viewer-note">The file isn't on disk any more.</p>
        </Show>
      </div>
      <aside class="viewer-side">
        <button class="viewer-close" aria-label="Close" onClick={p.onClose}>
          ×
        </button>
        <h2 class="viewer-name">{p.item.filename}</h2>
        <dl class="facts">
          <dt>What</dt>
          <dd>{SINGULAR[p.item.kind] ?? p.item.kind}</dd>
          <dt>From</dt>
          <dd>
            {p.item.user_name ?? p.item.username ?? 'Unknown'}
            <Show when={p.item.username}>
              <span class="muted small mono"> {p.item.username}</span>
            </Show>
          </dd>
          <dt>Where</dt>
          <dd>{where(p.item)}</dd>
          <dt>When</dt>
          <dd>{p.item.created_at ? dateTime(p.item.created_at) : 'Unknown'}</dd>
          <dt>Size</dt>
          <dd>{bytes(p.item.size)}</dd>
          <dt>Type</dt>
          <dd class="mono small">{p.item.content_type ?? 'Unknown'}</dd>
        </dl>
        <div class="viewer-actions">
          <Show when={p.hasPrev}>
            <button class="btn" onClick={() => p.onStep(-1)}>
              Previous
            </button>
          </Show>
          <Show when={p.hasNext}>
            <button class="btn" onClick={() => p.onStep(1)}>
              Next
            </button>
          </Show>
          <Show when={!p.item.missing}>
            <a class="btn" href={p.item.file} target="_blank" rel="noopener noreferrer">
              Open original
            </a>
          </Show>
        </div>
        <div class="remove-box">
          <Show
            when={confirming()}
            fallback={
              <button class="btn danger" onClick={() => setConfirming(true)}>
                Remove this file
              </button>
            }
          >
            <p class="small">
              <b>Remove it for good?</b> {whatRemovalDoes(p.item)} This can't be undone.
            </p>
            <div class="viewer-actions">
              <button class="btn danger" disabled={busy()} onClick={remove}>
                {busy() ? 'Removing…' : 'Remove for good'}
              </button>
              <button class="btn" disabled={busy()} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          </Show>
          <Show when={error()}>
            <p class="error small" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      </aside>
    </div>
  );
}

const loadBlur = () => {
  try {
    return localStorage.getItem('monitor.blur') === '1';
  } catch {
    return false;
  }
};

export function Media() {
  const [totals, { refetch: refetchTotals }] = createResource(() => api<J>('GET', '/moderation/media/totals'));
  const [cls, setCls] = createSignal('');
  const [source, setSource] = createSignal('');
  const [server, setServer] = createSignal(route().arg);
  const [query, setQuery] = createSignal('');
  const [sort, setSort] = createSignal('newest');
  const [items, setItems] = createSignal<J[]>([]);
  const [total, setTotal] = createSignal(0);
  const [totalBytes, setTotalBytes] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [openAt, setOpenAt] = createSignal<number | null>(null);
  const [blur, setBlurState] = createSignal(loadBlur());
  const [removed, setRemoved] = createSignal('');
  const setBlur = (v: boolean) => {
    setBlurState(v);
    try {
      localStorage.setItem('monitor.blur', v ? '1' : '0');
    } catch {}
  };

  let run = 0;
  const load = async (append = false) => {
    const mine = ++run;
    setLoading(true);
    const params = new URLSearchParams({ sort: sort(), limit: String(PAGE), offset: String(append ? items().length : 0) });
    if (cls()) params.set('class', cls());
    if (source()) params.set('source', source());
    if (server()) params.set('server', server());
    if (query().trim()) params.set('q', query().trim());
    try {
      const r = await api<J>('GET', `/moderation/media?${params}`);
      if (mine !== run) return;
      setItems(append ? [...items(), ...r.items] : r.items);
      if (r.items.length || !append) {
        setTotal(r.total);
        setTotalBytes(r.total_bytes);
      }
      setError('');
    } catch (e) {
      if (mine === run) setError(e instanceof Error ? e.message : 'Could not load the media.');
    } finally {
      if (mine === run) setLoading(false);
    }
  };
  let timer: number | undefined;
  createEffect(
    on([cls, source, server, query, sort], () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 200);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const breakdown = () => (totals()?.breakdown ?? []) as J[];
  const classCount = (id: string) => breakdown().filter((b) => !id || b.class === id).reduce((a, b) => a + b.count, 0);
  const sourcesPresent = () => [...new Set(breakdown().map((b) => b.kind))];
  const open = () => (openAt() == null ? null : (items()[openAt()!] ?? null));
  const onRemoved = (m: J) => {
    const at = openAt()!;
    setItems(items().filter((x) => x !== m));
    setTotal(Math.max(0, total() - 1));
    setTotalBytes(Math.max(0, totalBytes() - (m.size ?? 0)));
    setRemoved(`Removed ${m.filename}.`);
    setTimeout(() => setRemoved(''), 4000);
    void refetchTotals();
    // Carries on with the next one, so going through a lot of them is quick.
    setOpenAt(items().length ? Math.min(at, items().length - 1) : null);
  };

  return (
    <Page title="Media" lead="Everything people have uploaded: attachments, including those in direct messages, pictures, banners, emoji, sounds and songs.">
      <div class="filters" role="search">
        <div class="seg" role="group" aria-label="Type">
          <For each={CLASSES}>
            {(c) => (
              <button classList={{ active: cls() === c.id }} aria-pressed={cls() === c.id} onClick={() => setCls(c.id)}>
                {c.label}
                <Show when={totals()}>
                  <span class="seg-count">{count(classCount(c.id))}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <select aria-label="Uploaded as" value={source()} onChange={(e) => setSource(e.currentTarget.value)}>
          <option value="">Uploaded as anything</option>
          <For each={sourcesPresent()}>{(k) => <option value={k}>{SOURCES[k] ?? k}</option>}</For>
        </select>
        <select aria-label="Where" value={server()} onChange={(e) => setServer(e.currentTarget.value)}>
          <option value="">Everywhere</option>
          <option value="dm">Direct messages</option>
          <For each={(totals()?.servers ?? []) as J[]}>{(g: J) => <option value={g.id} selected={server() === g.id}>{g.name}</option>}</For>
        </select>
        <select aria-label="Sort" value={sort()} onChange={(e) => setSort(e.currentTarget.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="largest">Largest first</option>
        </select>
        <input class="grow" type="search" placeholder="Search by file name, person or server" aria-label="Search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <label class="check">
          <input type="checkbox" checked={blur()} onChange={(e) => setBlur(e.currentTarget.checked)} />
          Blur previews
        </label>
      </div>

      <p class="result-line" aria-live="polite">
        <span class="mono">
          {count(total())} {total() === 1 ? 'file' : 'files'}, {bytes(totalBytes())}
        </span>
        <Show when={removed()}>
          <span class="status ok">{removed()}</span>
        </Show>
      </p>

      <Show when={error()}>
        <Notice level="critical">{error()}</Notice>
      </Show>

      <ul class="gallery" classList={{ refreshing: loading() && items().length > 0 }}>
        <For each={items()}>
          {(m: J, i) => (
            <li>
              <button class="media-card" onClick={() => setOpenAt(i())} aria-label={`Open ${m.filename}`}>
                <Thumb item={m} blur={blur()} />
                <span class="media-name" title={m.filename}>
                  {m.filename}
                </span>
                <span class="media-meta">{m.user_name ?? m.username ?? 'Unknown'}</span>
                <span class="media-meta" title={where(m)}>
                  {where(m)}
                </span>
                <span class="media-meta mono">
                  {bytes(m.size, 1)}
                  <Show when={m.created_at}>, {date(m.created_at)}</Show>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={!items().length && !loading() && !error()}>
        <p class="empty">{cls() || source() || server() || query() ? 'Nothing matches these filters. Clear some to see more.' : 'Nobody has uploaded anything yet.'}</p>
      </Show>
      <Show when={items().length < total()}>
        <button class="btn more" disabled={loading()} onClick={() => void load(true)}>
          {loading() ? 'Loading…' : `Show more (${count(total() - items().length)} left)`}
        </button>
      </Show>

      <Show when={open()}>
        <Viewer
          item={open()}
          onClose={() => setOpenAt(null)}
          onRemoved={onRemoved}
          hasPrev={(openAt() ?? 0) > 0}
          hasNext={(openAt() ?? 0) < items().length - 1}
          onStep={(dir) => setOpenAt((openAt() ?? 0) + dir)}
        />
      </Show>
    </Page>
  );
}
