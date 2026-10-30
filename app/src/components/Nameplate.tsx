import { createEffect, on, onCleanup, Show } from 'solid-js';

/** WebM nameplates are videos (the server names uploaded ones *.webm); everything else is a picture. */
export const isVideoNameplate = (url: string) => /\.webm(?:$|[?#])/i.test(url);

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Long lists (the picker, a big member list) would otherwise open hundreds of videos at once: each holds a
// connection and a decoder, and past a point the rest just never load. So a video only gets its source while
// it's on screen (plus a margin), and lets go of it when it scrolls away.
const visible = new Map<Element, (on: boolean) => void>();
const observer =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => entries.forEach((e) => visible.get(e.target)?.(e.isIntersecting)), {
        rootMargin: '200px 0px',
      })
    : null;

function LazyVideo(p: { src: string }) {
  let el!: HTMLVideoElement;
  const show = (on: boolean) => {
    if (on) {
      if (el.getAttribute('src') !== p.src) el.src = p.src;
      if (!reducedMotion()) void el.play().catch(() => {});
    } else if (el.hasAttribute('src')) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  };
  // A new nameplate while this one is on screen.
  createEffect(
    on(
      () => p.src,
      () => el?.hasAttribute('src') && show(true),
      { defer: true },
    ),
  );
  return (
    <video
      ref={(v) => {
        el = v;
        if (!observer) return void (v.src = p.src);
        visible.set(v, show);
        observer.observe(v);
        onCleanup(() => {
          observer.unobserve(v);
          visible.delete(v);
          show(false);
        });
      }}
      class="nameplate"
      data-src={p.src}
      muted
      loop
      playsinline
      disablepictureinpicture
      preload="none"
      aria-hidden="true"
    />
  );
}

/** A nameplate behind a member card: a picture, or a silent looping video (paused on its first frame for reduced motion). */
export function Nameplate(p: { src: string; lazy?: boolean }) {
  return (
    <Show
      when={isVideoNameplate(p.src)}
      fallback={<img class="nameplate" src={p.src} alt="" loading={p.lazy ? 'lazy' : undefined} draggable={false} />}
    >
      <Show
        when={p.lazy}
        fallback={
          <video
            class="nameplate"
            src={p.src}
            autoplay={!reducedMotion()}
            muted
            loop
            playsinline
            disablepictureinpicture
            preload="auto"
            aria-hidden="true"
          />
        }
      >
        <LazyVideo src={p.src} />
      </Show>
    </Show>
  );
}
