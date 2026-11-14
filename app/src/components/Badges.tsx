// Profile badges (lib/badges.ts): the strip on profile cards, the named chips on the full profile, the hover card
// that explains one, the "New badge" card and Settings -> Badges.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  arrangeBadges,
  badgesOf,
  type Badge,
  currentAmount,
  describe,
  dismissNewBadges,
  earnedDate,
  ladderName,
  loadMyBadges,
  myBadges,
  newBadges,
  progressText,
  tierArt,
  TIER_NAMES,
} from '../lib/badges';
import { plural, t } from '../lib/i18n';
import { state } from '../lib/store';
import { setUi, toast } from '../lib/ui';
import * as I from './Icons';

/** How many fit on a profile card; the full profile shows them all. */
const ON_CARD = 8;

export function BadgeArt(p: { badge: Badge; size: number; faded?: boolean }) {
  const info = () => describe(p.badge);
  return (
    <img
      class="badge-art"
      classList={{ faded: p.faded }}
      src={info()?.art}
      alt=""
      width={p.size}
      height={p.size}
      draggable={false}
    />
  );
}

// ---------- hover card ----------

type Hovered = { badge: Badge; userId: string; el: HTMLElement };

const [hovered, setHovered] = createSignal<Hovered | null>(null);

/** Shows the hover card for a badge while the pointer (or focus) is on it; a tap toggles it on touch screens. */
function hoverable(badge: Badge, userId: string) {
  const show = (el: HTMLElement) => setHovered({ badge, userId, el });
  const hide = (el: HTMLElement) => hovered()?.el === el && setHovered(null);
  return {
    tabIndex: 0,
    onPointerEnter: (e: PointerEvent) => e.pointerType === 'mouse' && show(e.currentTarget as HTMLElement),
    onPointerLeave: (e: PointerEvent) => e.pointerType === 'mouse' && hide(e.currentTarget as HTMLElement),
    onFocus: (e: FocusEvent) => show(e.currentTarget as HTMLElement),
    onBlur: (e: FocusEvent) => hide(e.currentTarget as HTMLElement),
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      if (hovered()?.el === el) setHovered(null);
      else show(el);
    },
  };
}

function BadgeHoverCard(p: { h: Hovered }) {
  let card!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const h = () => p.h;
  const info = () => describe(h().badge);
  // Your own milestones also say where you are and what's next.
  const progress = () =>
    h().userId === state.me?.id ? myBadges()?.progress.find((p) => p.id === h().badge.id) : undefined;
  createEffect(() => {
    const el = h().el;
    void info();
    queueMicrotask(() => {
      if (!el.isConnected) return setHovered(null);
      const r = el.getBoundingClientRect();
      const w = card.offsetWidth;
      const ht = card.offsetHeight;
      const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
      const y = r.top - ht - 8 >= 8 ? r.top - ht - 8 : Math.min(r.bottom + 8, innerHeight - ht - 8);
      setPos({ x, y });
    });
  });
  const close = () => setHovered(null);
  onMount(() => {
    addEventListener('scroll', close, true);
    addEventListener('pointerdown', close);
  });
  onCleanup(() => {
    removeEventListener('scroll', close, true);
    removeEventListener('pointerdown', close);
  });
  return (
    <Show when={info()}>
      {(i) => (
        <div
          class="badge-card"
          ref={card}
          role="tooltip"
          style={{ transform: `translate(${Math.round(pos().x)}px, ${Math.round(pos().y)}px)` }}
        >
          <div class="badge-card-head">
            <BadgeArt badge={h().badge} size={48} />
            <div>
              <strong>{i().name}</strong>
              <Show when={i().tierName} fallback={<span class="badge-card-sub">{i().about}</span>}>
                <span class={`badge-tier tier-${i().tier}`}>
                  {i().tierName} · {i().amount}
                </span>
              </Show>
            </div>
          </div>
          <Show when={progress()?.value != null && i().tierName}>
            <p class="badge-card-line">{currentAmount(progress()!)}</p>
          </Show>
          <Show when={h().badge.earned_at}>
            <p class="badge-card-line muted">{t('Earned {date}', { date: earnedDate(h().badge.earned_at) })}</p>
          </Show>
          <Show when={progress()?.next != null && progress()}>
            {(p) => (
              <div class="badge-card-next">
                <div class="badge-bar">
                  <span
                    class={`tier-bg-${p().next}`}
                    style={{ width: `${Math.min(100, (p().value / p().target!) * 100)}%` }}
                  />
                </div>
                <span>
                  {t('Next: {tier} at {amount}', {
                    tier: t(TIER_NAMES[p().next!]!),
                    amount: describe({ id: p().id, tier: p().next! })?.amount ?? '',
                  })}
                </span>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** One hover card for the whole app (App.tsx). */
export function BadgeHoverHost() {
  return (
    <Show when={hovered()} keyed>
      {(h) => (
        <Portal>
          <BadgeHoverCard h={h} />
        </Portal>
      )}
    </Show>
  );
}

// ---------- on profiles ----------

/** The badge strip on profile cards: the first few, in their owner's order. */
export function BadgeStrip(p: { userId: string }) {
  const list = () => (state.users[p.userId]?.bot ? [] : (badgesOf(p.userId) ?? []));
  return (
    <Show when={list().length}>
      <div class="badge-strip" role="list" aria-label={t('Badges')}>
        <For each={list().slice(0, ON_CARD)}>
          {(b) => (
            <span class="badge-slot" role="listitem" aria-label={describe(b)?.name} {...hoverable(b, p.userId)}>
              <BadgeArt badge={b} size={22} />
            </span>
          )}
        </For>
        <Show when={list().length > ON_CARD}>
          <span class="badge-more">+{list().length - ON_CARD}</span>
        </Show>
      </div>
    </Show>
  );
}

/** Every shown badge with its name, for the full profile. */
export function BadgeChips(p: { userId: string; badges?: Badge[] }) {
  const list = () => (p.userId === state.me?.id ? badgesOf(p.userId) : undefined) ?? p.badges ?? [];
  return (
    <Show when={list().filter((b) => describe(b)).length}>
      <div class="badge-chips" role="list" aria-label={t('Badges')}>
        <For each={list().filter((b) => describe(b))}>
          {(b) => (
            <span class="badge-chip" role="listitem" {...hoverable(b, p.userId)}>
              <BadgeArt badge={b} size={24} />
              {describe(b)!.amount ?? describe(b)!.name}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

// ---------- new badge card ----------

/** "New badge" in the corner when one is earned (several at once: the first, and how many more). */
export function BadgeEarnedHost() {
  let timer: number | undefined;
  createEffect(() => {
    clearTimeout(timer);
    if (newBadges().length) timer = window.setTimeout(dismissNewBadges, 12_000);
  });
  onCleanup(() => clearTimeout(timer));
  const first = () => newBadges()[0]!;
  const info = () => describe(first());
  return (
    <Show when={newBadges().length > 0 && info()}>
      {(i) => (
        <div class="badge-earned" role="status">
          <BadgeArt badge={first()} size={60} />
          <div class="badge-earned-text">
            <span class="badge-earned-kicker">{newBadges().length > 1 ? t('New badges') : t('New badge')}</span>
            <strong>
              {i().name}
              <Show when={i().tierName}> · {i().tierName}</Show>
            </strong>
            <span>
              {newBadges().length > 1
                ? plural(newBadges().length - 1, 'And {n} more.', 'And {n} more.')
                : (i().amount ?? i().about)}
            </span>
          </div>
          <button
            class="btn small-btn"
            onClick={() => {
              dismissNewBadges();
              setUi('modal', { type: 'settings', tab: 'badges' });
            }}
          >
            {t('See badges')}
          </button>
          <button class="icon-btn" aria-label={t('Close')} onClick={dismissNewBadges}>
            <I.Close size={16} />
          </button>
        </div>
      )}
    </Show>
  );
}

// ---------- Settings -> Badges ----------

export function BadgesPage() {
  onMount(() => void loadMyBadges());
  const all = () => (myBadges()?.badges ?? []).filter((b) => describe(b));
  const shown = () => all().filter((b) => !b.hidden);
  const save = (list: Badge[]) =>
    arrangeBadges(
      list.map((b) => b.id),
      list.filter((b) => b.hidden).map((b) => b.id),
    ).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  const setHidden = (ids: string[] | null, hidden: boolean) =>
    save(all().map((b) => (ids === null || ids.includes(b.id) ? { ...b, hidden } : b)));

  // Drag rows to reorder.
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [over, setOver] = createSignal<{ i: number; before: boolean } | null>(null);
  const move = (from: number, at: number) => {
    const list = [...all()];
    const [b] = list.splice(from, 1);
    list.splice(at, 0, b!);
    void save(list);
  };
  const drop = () => {
    const from = dragging();
    const to = over();
    setDragging(null);
    setOver(null);
    if (from === null || !to) return;
    let at = to.i + (to.before ? 0 : 1);
    if (from < at) at--;
    if (at !== from) move(from, at);
  };

  // Milestones with a next tier, closest first.
  const next = () =>
    (myBadges()?.progress ?? [])
      .filter((p) => p.next != null && p.target)
      .sort((a, b) => b.value / b.target! - a.value / a.target!);

  return (
    <div class="stack badges-settings">
      <p class="set-desc">
        {t(
          'Badges come as you use Pottira. Pick which ones your profile shows and in what order; new ones are shown when you earn them.',
        )}
      </p>
      <Show when={myBadges()} fallback={<p class="muted">{t('Loading…')}</p>}>
        <div class="badges-preview">
          <span class="field-label">{t('On your profile card')}</span>
          <Show when={shown().length} fallback={<span class="muted small">{t('No badges shown')}</span>}>
            <div class="badge-strip">
              <For each={shown().slice(0, ON_CARD)}>{(b) => <BadgeArt badge={b} size={22} />}</For>
            </div>
            <Show when={shown().length > ON_CARD}>
              <span class="muted small">
                {plural(shown().length - ON_CARD, '+{n} on your full profile', '+{n} on your full profile')}
              </span>
            </Show>
          </Show>
        </div>

        <div class="field-label favorite-games-head">
          {t('Your badges')} <em class="counter">{all().length}</em>
          <Show when={all().length}>
            <span class="badges-bulk">
              <button class="btn small-btn" onClick={() => void setHidden(null, false)}>
                {t('Show all')}
              </button>
              <button class="btn small-btn" onClick={() => void setHidden(null, true)}>
                {t('Hide all')}
              </button>
            </span>
          </Show>
        </div>
        <div class="badge-list">
          <For each={all()} fallback={<p class="empty-hint">{t('No badges yet. They come as you use Pottira.')}</p>}>
            {(b, i) => {
              const info = () => describe(b)!;
              return (
                <div
                  class="badge-row"
                  draggable={true}
                  classList={{
                    off: b.hidden,
                    dragging: dragging() === i(),
                    'drop-before': over()?.i === i() && over()!.before,
                    'drop-after': over()?.i === i() && !over()!.before,
                  }}
                  onDragStart={(e) => {
                    setDragging(i());
                    e.dataTransfer!.effectAllowed = 'move';
                    e.dataTransfer!.setData('text/plain', b.id);
                  }}
                  onDragOver={(e) => {
                    if (dragging() === null) return;
                    e.preventDefault();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setOver({ i: i(), before: e.clientY < r.top + r.height / 2 });
                  }}
                  onDrop={(e) => (e.preventDefault(), drop())}
                  onDragEnd={() => (setDragging(null), setOver(null))}
                >
                  <button
                    class="icon-btn badge-grip"
                    aria-label={t('Move {name} (Alt+Up / Alt+Down)', { name: info().name })}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                      e.preventDefault();
                      const to = i() + (e.key === 'ArrowUp' ? -1 : 1);
                      if (to >= 0 && to < all().length) move(i(), to);
                    }}
                  >
                    <I.GripVertical size={16} />
                  </button>
                  <BadgeArt badge={b} size={40} faded={b.hidden} />
                  <span class="badge-row-text">
                    <strong>{info().name}</strong>
                    <small>
                      <Show when={info().tierName}>
                        <span class={`badge-tier tier-${info().tier}`}>{info().tierName}</span> ·{' '}
                      </Show>
                      {info().amount ?? info().about}
                      <Show when={b.earned_at}> · {earnedDate(b.earned_at)}</Show>
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    class="switch"
                    aria-label={t('Show {name} on your profile', { name: info().name })}
                    checked={!b.hidden}
                    onChange={(e) => void setHidden([b.id], !e.currentTarget.checked)}
                  />
                </div>
              );
            }}
          </For>
        </div>

        <Show when={next().length}>
          <div class="field-label">{t('Next tiers')}</div>
          <div class="badge-next-list">
            <For each={next()}>
              {(p) => (
                <div class="badge-next">
                  <img class="badge-art faded" src={tierArt(p.id, p.next!)} alt="" width={36} height={36} />
                  <span class="badge-next-text">
                    <span class="badge-next-head">
                      <strong>
                        {t(TIER_NAMES[p.next!]!)} · {ladderName(p.id)}
                      </strong>
                      <span class="badge-next-value">{progressText(p)}</span>
                    </span>
                    <span class="badge-bar">
                      <span
                        class={`tier-bg-${p.next}`}
                        style={{ width: `${Math.min(100, (p.value / p.target!) * 100)}%` }}
                      />
                    </span>
                  </span>
                </div>
              )}
            </For>
          </div>
          <p class="muted small">
            {t('Time is counted since Stats came out (Pottira 1.0); account age counts from the day you joined.')}
          </p>
        </Show>
      </Show>
    </div>
  );
}
