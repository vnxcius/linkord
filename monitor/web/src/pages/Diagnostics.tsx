import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { api, dateTime, type J, ms } from '../lib';
import { Glyph, type Level, Notice, Page, Section } from '../ui';

const LEVEL: Record<string, Level> = { pass: 'ok', warn: 'warning', fail: 'critical', info: 'info' };
const WORD: Record<string, string> = { pass: 'Passed', warn: 'Warning', fail: 'Failed', info: 'Note' };

function Tool(p: { title: string; hint: string; fields: { key: string; placeholder: string; value?: string; width?: string; type?: string }[]; path: string; button: string }) {
  const values: Record<string, string> = Object.fromEntries(p.fields.map((f) => [f.key, f.value ?? '']));
  const [result, setResult] = createSignal<J>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const body: J = { ...values };
      if (body.port) body.port = Number(body.port);
      else delete body.port;
      setResult(await api('POST', p.path, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That failed.');
    } finally {
      setBusy(false);
    }
  };
  const summary = () => {
    const r = result();
    if (!r) return null;
    if (!r.ok && r.error) return r.error;
    if (r.addresses) return `${r.addresses.join(', ') || 'No addresses'}, in ${ms(r.ms)}`;
    if (r.tries) return `${r.answered} of ${r.tries} connected, ${ms(r.best_ms)} at best, ${ms(r.worst_ms)} at worst`;
    if (r.status) return `Answered ${r.status} in ${ms(r.ms)} over ${r.version}${r.headers?.server ? `, server: ${r.headers.server}` : ''}`;
    if (r.cert) return `${r.cert.days_left} days left. Issued by ${r.cert.issuer}. ${r.cert.protocol ?? ''}`;
    return JSON.stringify(r);
  };
  return (
    <form class="tool" onSubmit={submit}>
      <h3>{p.title}</h3>
      <p class="muted small">{p.hint}</p>
      <div class="tool-row">
        <For each={p.fields}>
          {(f) => (
            <input
              aria-label={f.placeholder}
              placeholder={f.placeholder}
              value={f.value ?? ''}
              type={f.type ?? 'text'}
              style={{ width: f.width, flex: f.width ? 'none' : '1' }}
              onInput={(e) => (values[f.key] = e.currentTarget.value)}
            />
          )}
        </For>
        <button class="btn" disabled={busy()}>
          {busy() ? 'Checking…' : p.button}
        </button>
      </div>
      <Show when={error()}>
        <p class="error small">{error()}</p>
      </Show>
      <Show when={result()}>
        <p class="tool-result small">
          <Glyph level={result().ok ? 'ok' : 'critical'} />
          <span>{summary()}</span>
        </p>
      </Show>
    </form>
  );
}

export function Diagnostics() {
  const [report, setReport] = createSignal<J>(null);
  const [running, setRunning] = createSignal(false);
  const [error, setError] = createSignal('');
  const [copied, setCopied] = createSignal(false);
  const run = async () => {
    setRunning(true);
    setError('');
    try {
      setReport(await api('POST', '/diagnostics/run'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The check failed.');
    } finally {
      setRunning(false);
    }
  };
  onMount(() => void run());
  const results = (): J[] => report()?.results ?? [];
  const groups = createMemo(() => {
    const names = [...new Set(results().map((r) => r.group))];
    return names.map((name) => ({ name, list: results().filter((r) => r.group === name) }));
  });
  const n = (status: string) => results().filter((r) => r.status === status).length;
  const copy = async () => {
    const text = [
      `Linkord diagnostics, ${dateTime(report().ran_at)}`,
      ...results().map((r) => `[${WORD[r.status]}] ${r.group} / ${r.name}: ${r.detail}${r.fix ? ` (${r.fix})` : ''}`),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Page
      title="Diagnostics"
      lead="Verifies everything the monitor can check, and says what to do about what it finds. Nothing here changes anything."
      actions={
        <>
          <Show when={report()}>
            <button class="btn" onClick={copy}>
              {copied() ? 'Copied' : 'Copy report'}
            </button>
          </Show>
          <button class="btn primary" onClick={run} disabled={running()}>
            {running() ? 'Checking…' : 'Check again'}
          </button>
        </>
      }
    >
      <Show when={error()}>
        <Notice level="critical">{error()}</Notice>
      </Show>
      <Show when={report()}>
        <p class="diag-summary">
          <span>
            <Glyph level="critical" /> {n('fail')} failed
          </span>
          <span>
            <Glyph level="warning" /> {n('warn')} warnings
          </span>
          <span>
            <Glyph level="ok" /> {n('pass')} passed
          </span>
          <span class="muted small mono">
            {dateTime(report().ran_at)}, took {ms(report().took_ms)}
          </span>
        </p>
      </Show>
      <div class="diag" classList={{ refreshing: running() }}>
        <For each={groups()}>
          {(g) => (
            <section class="diag-group">
              <h2>{g.name}</h2>
              <ul>
                <For each={g.list}>
                  {(r: J) => (
                    <li class={r.status}>
                      <Glyph level={LEVEL[r.status]} />
                      <div>
                        <p>
                          <b>{r.name}</b> <span class="visually-hidden">{WORD[r.status]}.</span> <span class="diag-detail">{r.detail}</span>
                        </p>
                        <Show when={r.fix}>
                          <p class="diag-fix">{r.fix}</p>
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>

      <Section title="Tools" note="For chasing a specific problem, tried from this machine.">
        <div class="tools">
          <Tool title="Look up a name" hint="What this machine's DNS answers." path="/tools/dns" button="Look up" fields={[{ key: 'host', placeholder: 'discord.com' }]} />
          <Tool
            title="Try a port"
            hint="Four connections; shows whether it's reachable and how fast."
            path="/tools/tcp"
            button="Connect"
            fields={[
              { key: 'host', placeholder: '1.1.1.1' },
              { key: 'port', placeholder: 'Port', value: '443', width: '76px', type: 'number' },
            ]}
          />
          <Tool title="Fetch an address" hint="What a web address answers from here." path="/tools/http" button="Fetch" fields={[{ key: 'url', placeholder: 'https://old.example.com/api/health' }]} />
          <Tool
            title="Read a certificate"
            hint="Who issued it and when it expires."
            path="/tools/tls"
            button="Read"
            fields={[
              { key: 'host', placeholder: 'direct.example.com' },
              { key: 'port', placeholder: 'Port', value: '443', width: '76px', type: 'number' },
            ]}
          />
        </div>
      </Section>
    </Page>
  );
}
