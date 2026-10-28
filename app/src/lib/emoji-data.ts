// Common emoji with shortcodes, for the picker's search and `:name` autocomplete.
// Grouped like the picker; each entry is "emoji name name2".
import { msg } from './msg';

const RAW: [string, string][] = [
  [msg('Smileys'), `😀 grinning|😃 smiley|😄 smile|😁 grin|😆 laughing|😅 sweat_smile|🤣 rofl|😂 joy|🙂 slight_smile|😉 wink|😊 blush|😇 innocent|🥰 smiling_face_with_hearts|😍 heart_eyes|🤩 star_struck|😘 kissing_heart|😋 yum|😛 stuck_out_tongue|😜 stuck_out_tongue_winking_eye|🤪 zany|😝 squint_tongue|🤑 money_mouth|🤗 hugging|🤭 hand_over_mouth|🤫 shush|🤔 thinking|🤐 zipper_mouth|🤨 raised_eyebrow|😐 neutral|😑 expressionless|😶 no_mouth|😏 smirk|😒 unamused|🙄 eye_roll|😬 grimacing|😮‍💨 exhale|😌 relieved|😔 pensive|😪 sleepy|🤤 drooling|😴 sleeping|😷 mask|🤒 sick|🤕 hurt|🤢 nauseated|🤮 vomiting|🥵 hot|🥶 cold|🥴 woozy|😵 dizzy|🤯 mind_blown|🤠 cowboy|🥳 partying|🥸 disguised|😎 sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 slight_frown|😮 open_mouth|😯 hushed|😲 astonished|😳 flushed|🥺 pleading|🥹 holding_back_tears|😦 frowning|😧 anguished|😨 fearful|😰 anxious|😥 sad_relieved|😢 cry|😭 sob|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary|😫 tired|🥱 yawn|😤 triumph|😡 rage|😠 angry|🤬 cursing|😈 smiling_imp|💀 skull|☠️ skull_crossbones|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot`],
  [msg('Gestures'), `👍 thumbsup +1|👎 thumbsdown -1|👌 ok_hand|🤌 pinched_fingers|🤏 pinching|✌️ v peace|🤞 crossed_fingers|🤟 love_you|🤘 metal|🤙 call_me|👈 point_left|👉 point_right|👆 point_up|👇 point_down|☝️ point_up_2|👋 wave|🤚 raised_back_of_hand|🖐️ hand_splayed|✋ raised_hand|🖖 vulcan|👏 clap|🙌 raised_hands|🫶 heart_hands|👐 open_hands|🤲 palms_up|🤝 handshake|🙏 pray|✍️ writing|💪 muscle|🦾 mechanical_arm|🫡 salute|👀 eyes|🧠 brain|🫠 melting`],
  [msg('Hearts'), `❤️ heart|🧡 orange_heart|💛 yellow_heart|💚 green_heart|💙 blue_heart|💜 purple_heart|🖤 black_heart|🤍 white_heart|🤎 brown_heart|💔 broken_heart|❣️ heart_exclamation|💕 two_hearts|💞 revolving_hearts|💓 heartbeat|💗 heartpulse|💖 sparkling_heart|💘 cupid|💝 gift_heart|✨ sparkles|⭐ star|🌟 star2 glowing_star|💫 dizzy_star|🔥 fire|💥 boom|💯 100|✅ white_check_mark|❌ x|❓ question|❗ exclamation|💤 zzz`],
  [msg('Adventure'), `🗡️ dagger|⚔️ crossed_swords|🛡️ shield|🏹 bow_and_arrow|🪃 boomerang|🔮 crystal_ball|🧿 nazar|💎 gem|🪙 coin|👑 crown|🗝️ old_key|🔑 key|🧭 compass|🗺️ map|🏰 castle|🏯 japanese_castle|⛰️ mountain|🌋 volcano|🏝️ island|🌲 evergreen|🌳 tree|🍄 mushroom|🌿 herb|🍃 leaves|🌾 rice|🌙 crescent_moon|☀️ sun|🌈 rainbow|⚡ zap|🌊 ocean wave|🐉 dragon|🦉 owl|🐴 horse|🦊 fox|🐺 wolf|🐸 frog|🐔 chicken|🐟 fish|🧚 fairy|🧝 elf|🧙 mage|🎮 video_game|🕹️ joystick|🎲 game_die|🏆 trophy|🎉 tada|🎊 confetti|🎵 musical_note|🎶 notes`],
  [msg('Food'), `🍎 apple|🍐 pear|🍊 tangerine|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🥑 avocado|🍆 eggplant|🥕 carrot|🌽 corn|🌶️ hot_pepper|🍞 bread|🧀 cheese|🍖 meat_on_bone|🍗 poultry_leg|🥩 steak|🍔 hamburger|🍟 fries|🍕 pizza|🌭 hotdog|🥪 sandwich|🌮 taco|🍜 ramen|🍣 sushi|🍙 rice_ball|🍪 cookie|🎂 birthday|🍰 cake|🍫 chocolate|🍿 popcorn|☕ coffee|🍵 tea|🧃 juice|🍺 beer|🍻 beers|🥂 champagne|🍷 wine`],
];

export interface EmojiEntry {
  char: string;
  names: string[];
}

export const EMOJI_GROUPS: { name: string; emojis: EmojiEntry[] }[] = RAW.map(([name, list]) => ({
  name,
  emojis: list.split('|').map((e) => {
    const [char, ...names] = e.split(' ');
    return { char, names };
  }),
}));

export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.emojis);

export function searchEmoji(q: string, limit = 40): EmojiEntry[] {
  const query = q.toLowerCase();
  const starts = ALL_EMOJI.filter((e) => e.names.some((n) => n.startsWith(query)));
  const contains = ALL_EMOJI.filter((e) => !starts.includes(e) && e.names.some((n) => n.includes(query)));
  return [...starts, ...contains].slice(0, limit);
}
