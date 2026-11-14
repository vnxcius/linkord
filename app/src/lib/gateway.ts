import { onSnowball } from './snowball';
import { onLeagueInvite, onLeagueInvited, onLeagueJoinRequest } from './league';
import { batch } from 'solid-js';
import { t } from './i18n';
import { produce, reconcile } from 'solid-js/store';
import { getToken, media, serverUrl, setToken } from './api';
import { loadMessages, maybeAck, receiveMessage, trimHistory } from './actions';
import { cmpId } from './ids';
import { isTauri, notify } from './platform';
import { prefs } from './prefs';
import { sounds } from './sounds';
import { report } from './report';
import { setSounds } from './soundboard';
import { putWatch, setServerNow, setWatches, type Watch } from './watch';
import {
  addDm,
  addGuild,
  isBlocked,
  isMuted,
  nameOf,
  notifyLevel,
  putMember,
  putUser,
  removeGuild,
  setRoles,
  setState,
  state,
  type BotCommand,
} from './store';
import type { Activity, Channel, Guild, Message, Rel, Settings, Status, User, VoiceState } from './types';
import { Kind } from './types';
import { onVoiceStateFromServer } from './voice';
import { onBadgeEarned, onBadgesUpdate } from './badges';

let ws: WebSocket | null = null;
let retry = 0;
let stopped = false;
let seq = 0;
/** Reconnecting after a server restart (close 4100): quiet unless it takes a while. */
let quiet = false;
let quietTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Tells the server whether Pottira is being used here, so phones only get notifications (server push.rs) when it
 * isn't: `active` on input (at most every 30 s, while focused), `away` as soon as the window or tab goes to the
 * background (minimized, switched apps on a phone).
 */
let lastActive = 0;
function reportActivity(force = false) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (document.visibilityState !== 'visible') {
    if (lastActive || force) ws.send(JSON.stringify({ op: 'away' }));
    lastActive = 0;
    return;
  }
  if (!document.hasFocus()) return;
  const now = Date.now();
  if (!force && now - lastActive < 30_000) return;
  lastActive = now;
  ws.send(JSON.stringify({ op: 'active' }));
}
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
  addEventListener(ev, () => reportActivity(), { capture: true, passive: true });
document.addEventListener('visibilitychange', () => reportActivity(true));
addEventListener('focus', () => reportActivity(true));
addEventListener('pagehide', () => reportActivity(true));

export function connectGateway() {
  stopped = false;
  const token = getToken();
  if (!token) return;
  if (!quiet) setState('connection', retry ? 'reconnecting' : 'connecting');
  const sock = new WebSocket(serverUrl().replace(/^http/, 'ws') + '/api/gateway');
  ws = sock;
  sock.onopen = () => {
    // Resume where we left off if the session is still alive server-side; otherwise start fresh.
    // `client` is for Settings -> Sessions: a browser can't tell the app apart from the Edge it runs on.
    const client = isTauri ? 'desktop' : 'web';
    const msg =
      state.sessionId && state.ready
        ? { op: 'resume', token, session_id: state.sessionId, seq, client }
        : { op: 'identify', token, client };
    sock.send(JSON.stringify(msg));
  };
  sock.onmessage = (e) => {
    const { s, t, d } = JSON.parse(e.data);
    if (s) seq = s;
    try {
      handle(t, d);
    } catch (err) {
      console.error('gateway event failed', t, err);
      report('error', `Gateway event ${t} failed`, err);
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
    // 4100: the server is restarting and the next one is already listening. Resume right away, without the
    // "reconnecting" banner unless it takes more than a couple of seconds.
    if (e.code === 4100 && !quiet) {
      quiet = true;
      retry = 0;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quiet = false;
        if (state.connection !== 'open') setState('connection', 'reconnecting');
      }, 2500);
      setTimeout(connectGateway, 50 + Math.random() * 300);
      return;
    }
    if (!quiet) setState('connection', 'reconnecting');
    const delay = Math.min(quiet ? 1000 : 30_000, 500 * 2 ** retry++) * (0.75 + Math.random() * 0.5);
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
  admin?: boolean;
  bot_commands?: BotCommand[];
  calls?: { channel_id: string; ringing: string[] }[];
  watches?: { channel_id: string; watch: Watch }[];
  server_now?: number;
}

function handle(t: string, d: any) {
  switch (t) {
    case 'READY':
      // Every connection checks for a release (someone offline when it came out gets it now).
      void import('./desktop').then((m) => m.checkForUpdates());
      return onReady(d as Ready);
    case 'APP_UPDATE':
      // A release just went out: the banner shows now, not at the next periodic check.
      return void import('./desktop').then((m) => m.checkForUpdates(d.version));
    case 'RESUMED':
      retry = 0;
      quiet = false;
      clearTimeout(quietTimer);
      lastActive = 0;
      reportActivity(true);
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
    case 'GUILD_SOUNDBOARD_UPDATE':
      return setSounds('guilds', d.guild_id, d.sounds);
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
      // Channels we haven't opened yet have nothing to update.
      if (!state.messages[d.channel_id]) return;
      return setState('messages', d.channel_id, 'list', (m) => m.id === d.id, reconcile(d as Message));
    case 'MESSAGE_DELETE':
      if (!state.messages[d.channel_id]) return;
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
    case 'BOT_COMMANDS_UPDATE':
      return setState('botCommands', d.commands ?? []);
    case 'CUSTOM_STATUS_UPDATE':
      return setState('customStatus', d.custom_status ?? null);
    case 'USER_CONNECTIONS_UPDATE':
      return setState('connectionsVersion', (n) => n + 1);
    case 'BADGE_EARNED':
      return onBadgeEarned(d.badges ?? []);
    case 'BADGES_UPDATE':
      return onBadgesUpdate(d);
    case 'USER_NOTE_UPDATE':
      return setState('notes', d.id, d.note);
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
    case 'SNOWBALL':
      return onSnowball(d);
    case 'LEAGUE_JOIN_REQUEST':
      return onLeagueJoinRequest(d);
    case 'LEAGUE_INVITE':
      return onLeagueInvite(d);
    case 'LEAGUE_INVITED':
      return void onLeagueInvited(d);
    case 'WATCH_UPDATE':
      setServerNow(d.server_now);
      return putWatch(d.channel_id, d.watch);
    case 'CALL_UPDATE':
      return setState('calls', d.channel_id, d.ringing);
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
  quiet = false;
  clearTimeout(quietTimer);
  lastActive = 0;
  queueMicrotask(() => reportActivity(true));
  seq = 0;
  batch(() => {
    setState('sessionId', d.session_id);
    setState('admin', !!d.admin);
    setState('botCommands', d.bot_commands ?? []);
    setServerNow(d.server_now);
    setWatches(reconcile(Object.fromEntries((d.watches ?? []).map((w) => [w.channel_id, w.watch]))));
    setState('calls', reconcile(Object.fromEntries((d.calls ?? []).map((c) => [c.channel_id, c.ringing]))));
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
    // Messages may have been missed while disconnected: each channel refreshes when it's opened, and keeps showing
    // what it has until then. Ones showing older history start over, like channels that are gone.
    for (const id of Object.keys(state.messages)) {
      if (!state.channels[id] || state.messages[id].hasNewer) setState('messages', id, undefined as never);
      else setState('messages', id, 'loaded', false);
    }
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
  const direct = m.content.includes(`<@${me.id}>`);
  const mentioned =
    ch.kind === Kind.Dm ||
    ch.kind === Kind.GroupDm ||
    direct ||
    roleMention ||
    !!m.mention_everyone ||
    m.referenced_message?.author.id === me.id;
  // Muting silences everything except direct @mentions, like Discord; "Nothing" silences even those.
  const level = ch.guild_id ? notifyLevel(ch) : 'all';
  if (level === 'none' || (isMuted(ch) && !direct)) return;
  if (mentioned) setState('mentions', m.channel_id, (n) => (n ?? 0) + 1);
  // Other server messages notify too when the channel is on "All messages" (the server badge shows a dot).
  else if (level !== 'all' || !ch.guild_id || m.author.bot || m.type) return;
  if (me.status === 'dnd') return;
  sounds.message();
  if (!prefs.desktopNotifications) return;
  const author = nameOf(m.author.id, ch.guild_id);
  const where = ch.guild_id ? `${author} (#${ch.name})` : author;
  const body =
    m.content.replace(/<@&?(\d+)>/g, (_, id) => '@' + nameOf(id, ch.guild_id)).replace(/<a?:(\w+):\d+>/g, ':$1:') ||
    (m.forwarded ? t('Forwarded a message') : t('Sent an attachment'));
  void notify(where, body.slice(0, 200), media(m.author.avatar), { channelId: m.channel_id, messageId: m.id });
}

function onReaction(add: boolean, d: { channel_id: string; message_id: string; user_id: string; emoji: string }) {
  if (!state.messages[d.channel_id]) return;
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
