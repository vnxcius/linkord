// Chat markdown: masked links, <url> links and backslash escapes (Kass's /queue uses all three).
// Run: cd tests && node --test markdown.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../app/src/lib/markdown.ts';

const render = (s) => renderMarkdown(s, { userName: () => 'someone' });
const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${href}">${text}</a>`;

test('masked links, with and without angle brackets', () => {
  assert.equal(render('[Docs](https://example.com/a)'), a('https://example.com/a', 'Docs'));
  assert.equal(render('see [**this**](<https://example.com/a?b=1&c=2>)'), `see ${a('https://example.com/a?b=1&amp;c=2', '<strong>this</strong>')}`);
  // Only web links become masked links.
  assert.equal(render('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('<url> is a plain link without the brackets', () => {
  assert.equal(render('<https://example.com/x>'), a('https://example.com/x', 'https://example.com/x'));
  assert.equal(render('https://example.com/x.'), `${a('https://example.com/x', 'https://example.com/x')}.`);
});

test('a backslash keeps markup characters as text', () => {
  assert.equal(render('\\*not bold\\*'), '*not bold*');
  assert.equal(render('a\\_b\\_c'), 'a_b_c');
  assert.equal(render('`\\*code\\*`'), '<code class="md-inline">\\*code\\*</code>');
});

test("Kass's /queue lines", () => {
  const html = render(
    "**Now playing:** [Gerudo Valley](<https://www.youtube.com/watch?v=abc>) `3:09`\n`1.` [Lost Woods \\(Saria's Song\\)](<https://www.youtube.com/watch?v=def>) `3:45`",
  );
  assert.ok(html.includes(a('https://www.youtube.com/watch?v=abc', 'Gerudo Valley')), html);
  assert.ok(html.includes(a('https://www.youtube.com/watch?v=def', 'Lost Woods (Saria&#39;s Song)')), html);
  assert.ok(!html.includes('](') && !html.includes('&lt;http') && !html.includes('\\'), html);
});

test('nothing breaks out of a link', () => {
  const inputs = [
    'https://a.b/[link](<https://x/autofocus/onfocus=alert(1)//>)',
    'https://a.b/[link](https://x/onmouseover=alert(1)//)',
    'https://a.b/`c" onmouseover="alert(1)`',
    '[x](<https://a.b/`c" onfocus="alert(1)`>)',
    '<https://a.b/\\" onfocus=alert(1)>',
    'https://a.b/<@1>',
    'https://a.b/\u00000\u0000[l](https://x/ onfocus=alert(1))',
    '\u00000\u0000 [a](https://x/)',
  ];
  for (const input of inputs) {
    const html = render(input);
    // Every attribute value is closed before the next tag or attribute starts: drop them, and only known tags remain.
    const bare = html.replace(/"[^"]*"/g, '""');
    assert.ok(!/<[^>]*\son\w+=/i.test(bare), html);
    for (const [, tag, attrs] of bare.matchAll(/<(\w+)([^>]*)>/g)) {
      if (tag === 'a') assert.equal(attrs.trim(), 'href="" target="" rel="" title=""', html);
    }
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.ok(!/[<>\u0000]/.test(href), html);
  }
});

test('a URL stops at the markup that follows it', () => {
  assert.equal(render('https://a.b/`c`'), `${a('https://a.b/', 'https://a.b/')}<code class="md-inline">c</code>`);
});

test("Discord's extras in bot cards: <t:…>, -# subtext and <#channel>", () => {
  const html = renderMarkdown('🟢 **Online** desde <t:1700000000:R>\n-# Entre num canal de voz para ouvir.\nem <#42>', {
    userName: () => 'someone',
    channelName: (id) => (id === '42' ? 'geral' : undefined),
    time: (unix, style) => `${style}:${unix}`,
  });
  assert.match(html, /<span class="md-time" title="[^"]+">R:1700000000<\/span>/);
  assert.match(html, /<div class="md-sub">Entre num canal de voz para ouvir\.<\/div>/);
  assert.match(html, /<span class="mention channel">#geral<\/span>/);
  // Not a timestamp: left as text.
  assert.equal(render('<t:abc>'), '&lt;t:abc&gt;');
});

// Shared with the Android app (android/core MarkdownTest): both renderers must give exactly this HTML.
test('shared fixtures (tests/fixtures/markdown.json)', async () => {
  const { readFileSync } = await import('node:fs');
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/markdown.json', import.meta.url), 'utf8'));
  const opts = {
    userName: (id) => (id === '7' ? 'me' : 'someone'),
    meId: '7',
    role: (id) => (id === '5' ? { name: 'mods', color: '#ff0000' } : undefined),
    emojiUrl: (id, a) => `/e/${id}.${a ? 'gif' : 'png'}`,
    channelName: (id) => (id === '42' ? 'geral' : undefined),
    time: (unix, style) => `${style}:${unix}`,
  };
  for (const c of cases) {
    const html = renderMarkdown(c.input, opts).replace(/<span class="md-time" title="[^"]*">/g, '<span class="md-time">');
    assert.equal(html, c.html, JSON.stringify(c.input));
  }
});
