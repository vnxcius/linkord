// Small Discord-flavored markdown renderer. Input is escaped before any markup is added.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface RenderOptions {
  userName: (id: string) => string;
  meId?: string;
  /** Role name and CSS color for <@&id> mentions. */
  role?: (id: string) => { name: string; color?: string } | undefined;
  emojiUrl?: (id: string, animated: boolean) => string;
  /** <#id>: the channel's name, if known. */
  channelName?: (id: string) => string | undefined;
  /** <t:unix:style>: the time as text (Discord's styles t T d D f F R). */
  time?: (unix: number, style: string) => string;
}

function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');
}

export function renderMarkdown(src: string, opts: RenderOptions): string {
  const slots: string[] = [];
  const slot = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // Slots hold finished HTML, so nothing from outside may look like one, and no URL below may swallow one: expanded
  // inside href="..." it would break out of the attribute.
  let s = src
    .replace(/\u0000/g, '')
    .replace(/```(?:([\w+-]+)\n)?([\s\S]*?)```/g, (_, _lang, code: string) =>
      slot(`<pre class="md-code"><code>${esc(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`),
    );
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => slot(`<code class="md-inline">${esc(c)}</code>`));
  // A backslash keeps the next character from being markup (Kass escapes song titles this way).
  s = s.replace(/\\([\\`*_~|[\]()<>#@:!.-])/g, (_, c: string) => slot(esc(c)));
  s = esc(s);
  s = s.replace(/&lt;@(\d+)&gt;/g, (_, id: string) =>
    slot(`<span class="mention${id === opts.meId ? ' me' : ''}" data-user="${id}">@${esc(opts.userName(id))}</span>`),
  );
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id: string) => {
    const r = opts.role?.(id);
    const style = r?.color ? ` style="--role:${r.color}"` : '';
    return slot(`<span class="mention role"${style}>@${esc(r?.name ?? 'deleted-role')}</span>`);
  });
  s = s.replace(
    /(^|\s)@(everyone|here)\b/g,
    (_, pre: string, who: string) => pre + slot(`<span class="mention everyone">@${who}</span>`),
  );
  s = s.replace(/&lt;(a?):(\w{2,32}):(\d+)&gt;/g, (_, a: string, name: string, id: string) =>
    opts.emojiUrl
      ? slot(
          `<img class="emoji custom" src="${opts.emojiUrl(id, a === 'a')}" alt=":${name}:" title=":${name}:" draggable="false">`,
        )
      : `:${name}:`,
  );
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id: string) => {
    const name = opts.channelName?.(id);
    return slot(`<span class="mention channel">#${esc(name ?? 'unknown')}</span>`);
  });
  s = s.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (_, n: string, style?: string) => {
    const unix = Number(n);
    const text = opts.time ? opts.time(unix, style ?? 'f') : new Date(unix * 1000).toLocaleString();
    return slot(`<span class="md-time" title="${esc(new Date(unix * 1000).toLocaleString())}">${esc(text)}</span>`);
  });
  const link = (url: string, text: string) =>
    slot(`<a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${text}</a>`);
  // Masked links: [text](url), or [text](<url>) as Discord writes them when the URL shouldn't get a preview.
  s = s.replace(
    /\[([^\]\n]+)\]\((?:&lt;(https?:\/\/[^\s\u0000]+?)&gt;|(https?:\/\/[^\s()\u0000]+))\)/g,
    (_, text: string, a?: string, b?: string) => link((a ?? b)!, inline(text)),
  );
  // <url>: a plain link, shown without the angle brackets.
  s = s.replace(/&lt;(https?:\/\/[^\s\u0000]+?)&gt;/g, (_, url: string) => link(url, url));
  s = s.replace(/https?:\/\/[^\s<\u0000]+[^\s<.,:;"')\]!?\u0000]/g, (url) => link(url, url));

  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    quote = [];
  };
  for (const line of s.split('\n')) {
    const q = line.match(/^&gt; ?(.*)$/);
    if (q) {
      quote.push(inline(q[1]));
      continue;
    }
    flushQuote();
    // -# small grey text under a line, like Discord's subtext.
    const sub = line.match(/^-# (.+)$/);
    if (sub) {
      out.push(`<div class="md-sub">${inline(sub[1])}</div>`);
      continue;
    }
    const h = line.match(/^(#{1,3}) (.+)$/);
    const li = line.match(/^\s*[-*] (.+)$/);
    if (h) out.push(`<div class="md-h${h[1].length}">${inline(h[2])}</div>`);
    else if (li) out.push(`<div class="md-li">${inline(li[1])}</div>`);
    else out.push(inline(line) + '\n');
  }
  flushQuote();

  let html = out.join('').replace(/\n$/, '').replace(/\n/g, '<br>');
  for (let i = 0; i < 3 && html.includes('\u0000'); i++) html = html.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[+n]);
  return html;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

/** Messages made only of a few emoji are shown large, like Discord. */
export function isJumbo(content: string): boolean {
  const t = content.trim();
  if (!t || /^[\d#*\s]+$/.test(t) || !EMOJI_ONLY.test(t)) return false;
  return [...new Intl.Segmenter().segment(t.replace(/\s/g, ''))].length <= 27;
}
