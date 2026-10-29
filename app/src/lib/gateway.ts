import { batch } from 'solid-js';
import { t } from './i18n';
import { produce, reconcile } from 'solid-js/store';
import { getToken, media, serverUrl, setToken } from './api';
import { loadMessages, maybeAck, receiveMessage, trimHistory } from './actions';
import { cmpId } from './ids';
import { notify } from './platform';
import { prefs } from './prefs';
import { sounds } from './sounds';
import {
  addDm,
  addGuild,
  isBlocked,
  isMuted,
  nameOf,
  putMember,
  putUser,
  removeGuild,
  setRoles,
  setState,
  state,
} from './store';
import type { Activity, Channel, Guild, Message, Rel, Settings, Status, User, VoiceState } from './types';
import { Kind } from './types';
import { onVoiceStateFromServer } from './voice';

let ws: WebSocket | null = null;
let retry = 0;
let stopped = false;
let seq = 0;

export function connectGateway() {
  stopped = false;
  const token = getToken();
  if (!token) return;
  setState('connection', retry ? 'reconnecting' : 'connecting');
  const sock = new WebSocket(serverUrl().replace(/^http/, 'ws') + '/api/gateway');
  ws = sock;
  sock.onopen = () => {
    // Resume where we left off if the session is still alive server-side; otherwise start fresh.
    const msg =
      state.sessionId && state.ready
        ? { op: 'resume', token, session_id: state.sessionId, seq }
        : { op: 'identify', token };
    sock.send(JSON.stringify(msg));
  };
  sock.onmessage = (e) => {
    const { s, t, d } = JSON.parse(e.data);
    if (s) seq = s;
    try {
      handle(t, d);
    } catch (err) {
      console.error('gateway event failed', t, err);
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    if (e.code === 4001) {
      setToken(null);
      location.reload();
      return;
    }
    if (stopped) return;
    setState('connection', 'reconnecting');
    const delay = Math.min(30_000, 500 * 2 ** retry++) * (0.75 + Math.random() * 0.5);
    setTimeout(connectGateway, delay);
  };
}

export function disconnectGateway() {
  stopped = true;
  ws?.close();
  ws = null;
}

interface Ready {
  session_id: string;
  user: User;
  guilds: Guild[];
  dms: Channel[];
  relationships: { id: string; type: Rel; user: User }[];
  settings: Settings;
  presences: Record<string, Status>;
  activities?: Record<string, Activity[]>;
  custom_status?: Activity | null;
  read_states: Record<string, string>;
  voice_states: VoiceState[];
  voice_channel_statuses?: { channel_id: string; status: string }[];
}

function handle(t: string, d: any) {
  switch (t) {
    case 'READY':
      return onReady(d as Ready);
    case 'RESUMED':
      retry = 0;
      return setState('connection', 'open');
    case 'GUILD_CREATE':
      return addGuild(d as Guild);
    case 'GUILD_UPDATE':
      return setState('guilds', d.id, d);
    case 'GUILD_DELETE':
      return removeGuild(d.id);
    case 'GUILD_MEMBER_ADD':
      return batch(() => {
        putMember(d.guild_id, d.member);
        setState('presences', d.member.user.id, d.status);
      });
    case 'GUILD_MEMBER_UPDATE':
      return putMember(d.guild_id, d.member);
    case 'GUILD_MEMBER_REMOVE':
      return setState(
        'members',
        d.guild_id,
        produce((m) => delete m[d.user_id]),
      );
    case 'GUILD_ROLES_UPDATE':
      return setRoles(d.guild_id, d.roles);
    case 'GUILD_ROLE_UPDATE':
      return setState('roles', d.guild_id, d.role.id, d.role);
    case 'GUILD_EMOJIS_UPDATE':
      return setState('emojis', d.guild_id, d.emojis);
    case 'CHANNEL_CREATE':
      return isPrivateKind(d.kind) ? addDm(d) : setState('channels', d.id, d);
    case 'CHANNEL_UPDATE':
      return setState('channels', d.id, (c) => ({ ...c, ...d, recipients: c?.recipients }));
    case 'CHANNEL_DELETE':
      return batch(() => {
        setState(
          'channels',
          produce((c) => delete c[d.id]),
        );
        setState('dmOrder', (o) => o.filter((x) => x !== d.id));
        const view = d.guild_id ?? '@me';
        if (state.selected[view] === d.id) setState('selected', view, d.parent_id ?? undefined);
      });
    case 'CHANNEL_RECIPIENT_ADD':
      return batch(() => {
        putUser(d.user);
        setState('channels', d.channel_id, 'recipients', (r) => [...(r ?? []), d.user]);
      });
    case 'CHANNEL_RECIPIENT_REMOVE':
      return setState('channels', d.channel_id, 'recipients', (r) => (r ?? []).filter((u) => u.id !== d.user_id));
    case 'MESSAGE_CREATE':
      return onMessage(d as Message);
    case 'MESSAGE_UPDATE':
      return setState('messages', d.channel_id, 'list', (m) => m.id === d.id, reconcile(d as Message));
    case 'MESSAGE_DELETE':
      return setState('messages', d.channel_id, 'list', (l) => l?.filter((m) => m.id !== d.id));
    case 'MESSAGE_ACK':
      return batch(() => {
        const cur = state.readStates[d.channel_id];
        if (!cur || cmpId(d.message_id, cur) > 0) setState('readStates', d.channel_id, d.message_id);
        setState('mentions', d.channel_id, 0);
      });
    case 'REACTION_ADD':
    case 'REACTION_REMOVE':
      return onReaction(t === 'REACTION_ADD', d);
    case 'TYPING_START':
      return setState('typing', d.channel_id, (m) => ({ ...(m ?? {}), [d.user_id]: Date.now() + 10_000 }));
    case 'PRESENCE_UPDATE':
      return batch(() => {
        setState('presences', d.user_id, d.status);
        setState('activities', d.user_id, reconcile(d.activities ?? []));
      });
    case 'CUSTOM_STATUS_UPDATE':
      return setState('customStatus', d.custom_status ?? null);
    case 'USER_CONNECTIONS_UPDATE':
      return setState('connectionsVersion', (n) => n + 1);
    case 'USER_UPDATE':
      return batch(() => {
        putUser(d);
        if (d.id === state.me?.id) setState('me', (me) => ({ ...me!, ...d }));
      });
    case 'USER_SETTINGS_UPDATE':
      return setState('settings', reconcile(d));
    case 'RELATIONSHIP_ADD':
      return batch(() => {
        putUser(d.user);
        setState('relationships', d.id, d.type);
      });
    case 'RELATIONSHIP_REMOVE':
      return setState(
        'relationships',
        produce((r) => delete r[d.id]),
      );
    case 'VOICE_CHANNEL_STATUS_UPDATE':
      if (d.status) return setState('voiceStatus', d.channel_id, d.status);
      return setState(
        'voiceStatus',
        produce((s) => delete s[d.channel_id]),
      );
    case 'VOICE_STATE_UPDATE':
      onVoiceStateFromServer(d as VoiceState, state.voice[d.user_id]);
      return batch(() => {
        if (d.channel_id) setState('voice', d.user_id, d);
        else
          setState(
            'voice',
            produce((v) => delete v[d.user_id]),
          );
      });
  }
}

const isPrivateKind = (k: Kind) => k === Kind.Dm || k === Kind.GroupDm;

function onReady(d: Ready) {
  retry = 0;
  seq = 0;
  batch(() => {
    setState('sessionId', d.session_id);
    setState('me', d.user);
    putUser(d.user);
    setState('guildOrder', []);
    setState('channels', reconcile({}));
    for (const g of d.guilds) addGuild(g);
    setState('dmOrder', []);
    for (const c of d.dms) addDm(c);
    for (const r of d.relationships) putUser(r.user);
    setState('relationships', reconcile(Object.fromEntries(d.relationships.map((r) => [r.id, r.type]))));
    setState('settings', reconcile(d.settings ?? {}));
    setState('presences', reconcile(d.presences));
    setState('activities', reconcile(d.activities ?? {}));
    setState('customStatus', d.custom_status ?? null);
    setState('readStates', reconcile(d.read_states));
    setState('voice', reconcile(Object.fromEntries(d.voice_states.map((v) => [v.user_id, v]))));
    setState(
      'voiceStatus',
      reconcile(Object.fromEntries((d.voice_channel_statuses ?? []).map((s) => [s.channel_id, s.status]))),
    );
    // Messages may have been missed while disconnected; refetch lazily.
    setState('messages', reconcile({}));
    if (state.view !== '@me' && !state.guilds[state.view]) setState('view', '@me');
    setState('connection', 'open');
    setState('ready', true);
  });
  const ch = state.selected[state.view];
  if (ch)
    loadMessages(ch)
      .then(() => maybeAck(ch))
      .catch(() => {});
}

function onMessage(m: Message) {
  putUser(m.author);
  const ch = state.channels[m.channel_id];
  const viewing = state.selected[state.view] === m.channel_id;
  batch(() => {
    if (ch) setState('channels', m.channel_id, 'last_message_id', m.id);
    receiveMessage(m);
    setState(
      'typing',
      m.channel_id,
      produce((t) => t && delete t[m.author.id]),
    );
  });
  if (!viewing) trimHistory(m.channel_id);
  const me = state.me;
  if (!me || !ch) return;
  if (m.author.id === me.id) {
    setState('readStates', m.channel_id, m.id);
    return;
  }
  if (viewing && document.hasFocus()) return maybeAck(m.channel_id);
  if (isBlocked(m.author.id)) return;

  const roleMention = (state.members[ch.guild_id ?? '']?.[me.id]?.roles ?? []).some((r) =>
    m.content.includes(`<@&${r}>`),
  );
  const mentioned =
    ch.kind === Kind.Dm ||
    ch.kind === Kind.GroupDm ||
    m.content.includes(`<@${me.id}>`) ||
    roleMention ||
    !!m.mention_everyone ||
    m.referenced_message?.author.id === me.id;
  // Muting silences everything except direct @mentions, like Discord.
  if (!mentioned || (isMuted(ch) && !m.content.includes(`<@${me.id}>`))) return;
  setState('mentions', m.channel_id, (n) => (n ?? 0) + 1);
  if (me.status === 'dnd') return;
  sounds.message();
  if (!prefs.desktopNotifications) return;
  const author = nameOf(m.author.id, ch.guild_id);
  const where = ch.guild_id ? `${author} (#${ch.name})` : author;
  const body =
    m.content.replace(/<@&?(\d+)>/g, (_, id) => '@' + nameOf(id, ch.guild_id)).replace(/<a?:(\w+):\d+>/g, ':$1:') ||
    (m.forwarded ? t('Forwarded a message') : t('Sent an attachment'));
  void notify(where, body.slice(0, 200), media(m.author.avatar));
}

function onReaction(add: boolean, d: { channel_id: string; message_id: string; user_id: string; emoji: string }) {
  setState(
    'messages',
    d.channel_id,
    'list',
    (m) => m.id === d.message_id,
    'reactions',
    produce((rs: Message['reactions']) => {
      const r = rs.find((x) => x.emoji === d.emoji);
      if (add) {
        if (!r) rs.push({ emoji: d.emoji, users: [d.user_id] });
        else if (!r.users.includes(d.user_id)) r.users.push(d.user_id);
      } else if (r) {
        r.users = r.users.filter((u) => u !== d.user_id);
        if (!r.users.length) rs.splice(rs.indexOf(r), 1);
      }
    }),
  );
}

window.addEventListener('focus', () => {
  const ch = state.selected[state.view];
  if (ch) maybeAck(ch);
});
