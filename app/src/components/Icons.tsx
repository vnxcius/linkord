// UI icons from Heroicons (MIT, outline set), under the names the components use. Heroicons has no headphones,
// pushpin, controller, keyboard, picture-in-picture, signal bars or crossed-out mic, so those are drawn below on
// the same 24px grid and stroke. The Linkord emblem is the app icon itself (a picture).
import type { JSX } from 'solid-js';
import { Show, splitProps } from 'solid-js';
import { brandOf } from '../lib/brand-icons';
import emblemUrl from '../assets/emblem.png';
import emblemChristmasUrl from '../assets/emblem-christmas.png';
import { isChristmas } from '../lib/theme';
import adjustmentsHorizontal from 'heroicons/24/outline/adjustments-horizontal.svg?raw';
import arrowDownTray from 'heroicons/24/outline/arrow-down-tray.svg?raw';
import devicePhoneMobile from 'heroicons/24/outline/device-phone-mobile.svg?raw';
import arrowPath from 'heroicons/24/outline/arrow-path.svg?raw';
import arrowRight from 'heroicons/24/outline/arrow-right.svg?raw';
import arrowRightStartOnRectangle from 'heroicons/24/outline/arrow-right-start-on-rectangle.svg?raw';
import arrowTopRightOnSquare from 'heroicons/24/outline/arrow-top-right-on-square.svg?raw';
import arrowUturnLeft from 'heroicons/24/outline/arrow-uturn-left.svg?raw';
import arrowUturnRight from 'heroicons/24/outline/arrow-uturn-right.svg?raw';
import arrowsPointingIn from 'heroicons/24/outline/arrows-pointing-in.svg?raw';
import arrowsPointingOut from 'heroicons/24/outline/arrows-pointing-out.svg?raw';
import arrowsRightLeft from 'heroicons/24/outline/arrows-right-left.svg?raw';
import atSymbol from 'heroicons/24/outline/at-symbol.svg?raw';
import bell from 'heroicons/24/outline/bell.svg?raw';
import bellSlash from 'heroicons/24/outline/bell-slash.svg?raw';
import camera from 'heroicons/24/outline/camera.svg?raw';
import chartBar from 'heroicons/24/outline/chart-bar.svg?raw';
import chatBubbleLeftRight from 'heroicons/24/outline/chat-bubble-left-right.svg?raw';
import chatBubbleOvalLeft from 'heroicons/24/outline/chat-bubble-oval-left.svg?raw';
import check from 'heroicons/24/outline/check.svg?raw';
import chevronDown from 'heroicons/24/outline/chevron-down.svg?raw';
import chevronLeft from 'heroicons/24/outline/chevron-left.svg?raw';
import chevronUp from 'heroicons/24/outline/chevron-up.svg?raw';
import cog6Tooth from 'heroicons/24/outline/cog-6-tooth.svg?raw';
import computerDesktop from 'heroicons/24/outline/computer-desktop.svg?raw';
import documentDuplicate from 'heroicons/24/outline/document-duplicate.svg?raw';
import exclamationTriangle from 'heroicons/24/outline/exclamation-triangle.svg?raw';
import eye from 'heroicons/24/outline/eye.svg?raw';
import eyeSlash from 'heroicons/24/outline/eye-slash.svg?raw';
import swatch from 'heroicons/24/outline/swatch.svg?raw';
import sun from 'heroicons/24/outline/sun.svg?raw';
import moon from 'heroicons/24/outline/moon.svg?raw';
import faceSmile from 'heroicons/24/outline/face-smile.svg?raw';
import folder from 'heroicons/24/outline/folder.svg?raw';
import folderOpen from 'heroicons/24/outline/folder-open.svg?raw';
import forward from 'heroicons/24/outline/forward.svg?raw';
import globeAlt from 'heroicons/24/outline/globe-alt.svg?raw';
import hashtag from 'heroicons/24/outline/hashtag.svg?raw';
import informationCircle from 'heroicons/24/outline/information-circle.svg?raw';
import language from 'heroicons/24/outline/language.svg?raw';
import link from 'heroicons/24/outline/link.svg?raw';
import lockClosed from 'heroicons/24/outline/lock-closed.svg?raw';
import magnifyingGlass from 'heroicons/24/outline/magnifying-glass.svg?raw';
import microphone from 'heroicons/24/outline/microphone.svg?raw';
import minus from 'heroicons/24/outline/minus.svg?raw';
import paperAirplane from 'heroicons/24/outline/paper-airplane.svg?raw';
import paperClip from 'heroicons/24/outline/paper-clip.svg?raw';
import pause from 'heroicons/24/outline/pause.svg?raw';
import pencil from 'heroicons/24/outline/pencil.svg?raw';
import pencilSquare from 'heroicons/24/outline/pencil-square.svg?raw';
import phoneXMark from 'heroicons/24/outline/phone-x-mark.svg?raw';
import phone from 'heroicons/24/outline/phone.svg?raw';
import tv from 'heroicons/24/outline/tv.svg?raw';
import photo from 'heroicons/24/outline/photo.svg?raw';
import play from 'heroicons/24/outline/play.svg?raw';
import plus from 'heroicons/24/outline/plus.svg?raw';
import speakerWave from 'heroicons/24/outline/speaker-wave.svg?raw';
import speakerXMark from 'heroicons/24/outline/speaker-x-mark.svg?raw';
import speakerWaveSolid from 'heroicons/24/solid/speaker-wave.svg?raw';
import chatBubbleOvalSolid from 'heroicons/24/solid/chat-bubble-oval-left.svg?raw';
import star from 'heroicons/24/outline/star.svg?raw';
import musicalNote from 'heroicons/24/outline/musical-note.svg?raw';
import stop from 'heroicons/24/outline/stop.svg?raw';
import trash from 'heroicons/24/outline/trash.svg?raw';
import userCircle from 'heroicons/24/outline/user-circle.svg?raw';
import userPlus from 'heroicons/24/outline/user-plus.svg?raw';
import users from 'heroicons/24/outline/users.svg?raw';
import videoCamera from 'heroicons/24/outline/video-camera.svg?raw';
import windowIcon from 'heroicons/24/outline/window.svg?raw';
import xMark from 'heroicons/24/outline/x-mark.svg?raw';

type P = { size?: number } & JSX.SvgSVGAttributes<SVGSVGElement>;

/** The shapes inside a Heroicons file (everything between its <svg> tags). */
const body = (svg: string) =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();

/** Outline icons are stroked; `filled` is for Heroicons' solid set. */
const icon =
  (shapes: string, filled = false) =>
  (p: P) => {
    const [own, rest] = splitProps(p, ['size']);
    return (
      <svg
        width={own.size ?? 20}
        height={own.size ?? 20}
        viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? undefined : 'currentColor'}
        stroke-width={filled ? undefined : 1.5}
        aria-hidden="true"
        {...rest}
        innerHTML={shapes}
      />
    );
  };
const hero = (svg: string) => icon(body(svg));
const heroSolid = (svg: string) => icon(body(svg), true);

/** Our own shapes in Heroicons' style: rounded caps and joins. */
const path = (d: string, extra = '') => `<path stroke-linecap="round" stroke-linejoin="round" d="${d}"${extra}/>`;
/** Crossed out the way Heroicons draws its *-slash icons. */
const slashed = (shapes: string) => shapes + path('m3 3 18 18');

const headphones =
  path('M3.75 15v-3a8.25 8.25 0 0 1 16.5 0v3') +
  path(
    'M3.75 15.75a1.5 1.5 0 0 1 1.5-1.5h1.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-1.5a1.5 1.5 0 0 1-1.5-1.5v-3Z',
  ) +
  path(
    'M20.25 15.75a1.5 1.5 0 0 0-1.5-1.5h-1.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 .75.75h1.5a1.5 1.5 0 0 0 1.5-1.5v-3Z',
  );
const bars = (n: number) =>
  ['M4.5 20.25V17', 'M9.5 20.25v-7', 'M14.5 20.25V9', 'M19.5 20.25V4.5']
    .slice(0, n)
    .map((d) => path(d, ' stroke-width="2"'))
    .join('');

export const Hash = hero(hashtag);
export const Chart = hero(chartBar);
export const Speaker = heroSolid(speakerWaveSolid);
export const ChatBubble = heroSolid(chatBubbleOvalSolid);
export const Phone = hero(phone);
export const Desktop = hero(computerDesktop);
export const MobileDevice = hero(devicePhoneMobile);
export const UserCircle = hero(userCircle);
export const Tv = hero(tv);
/** A window with its left column marked: show or hide the channel list. */
export const Sidebar = icon(
  path(
    'M3.75 6.75A2.25 2.25 0 0 1 6 4.5h12a2.25 2.25 0 0 1 2.25 2.25v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z',
  ) + path('M9 4.5v15'),
);
/** Theater mode: a wide screen. */
export const Theater = icon(
  path(
    'M2.25 9a1.5 1.5 0 0 1 1.5-1.5h16.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V9Z',
  ),
);
export const Music = hero(musicalNote);
/** Group DM owner: a crown on Heroicons' grid. */
export const Crown = icon(path('M3.75 18.75h16.5M4.5 15.75 3 6.75l5.25 4.5L12 4.5l3.75 6.75L21 6.75l-1.5 9H4.5Z'));
export const Mic = hero(microphone);
export const MicOff = icon(slashed(body(microphone)));
export const Headphones = icon(headphones);
export const HeadphonesOff = icon(slashed(headphones));
export const Gear = hero(cog6Tooth);
export const Plus = hero(plus);
export const Close = hero(xMark);
export const Reply = hero(arrowUturnLeft);
export const Forward = hero(arrowUturnRight);
export const Edit = hero(pencil);
export const EditProfile = hero(pencilSquare);
export const Language = hero(language);
export const Trash = hero(trash);
export const Info = hero(informationCircle);
export const Smile = hero(faceSmile);
export const Paperclip = hero(paperClip);
export const Screen = hero(computerDesktop);
/** The controller, everywhere (owner, 2026-11-12): Lucide's gamepad-2 filled, with the d-pad and buttons cut out
 *  (the outline's buttons vanished at small sizes). */
export const Gamepad = icon(
  '<path fill-rule="evenodd" d="' +
    'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z' +
    // d-pad
    'M7.1 9h1.8v1.1H10v1.8H8.9V13H7.1v-1.1H6v-1.8h1.1z' +
    // buttons
    'M13.75 12a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0z' +
    'M16.75 10a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0z' +
    '"/>',
  true,
);
/** Steve's pickaxe (owner, 2026-11-12): the pixel pickaxe of his picture (server/assets/steve.svg), filled. */
export const Pickaxe = icon(
  '<path d="M15.6 0.3 15.6 2.1 19.2 2.1 19.2 3.9 21 3.9 21 9.3 22.8 9.3 22.8 16.5 21 16.5 21 14.7 19.2 14.7 19.2 9.3 15.6 9.3 15.6 11.1 13.8 11.1 13.8 12.9 12 12.9 12 14.7 10.2 14.7 10.2 16.5 8.4 16.5 8.4 18.3 6.6 18.3 6.6 20.1 4.8 20.1 4.8 21.9 3 21.9 3 23.7 1.2 23.7 1.2 20.1 3 20.1 3 18.3 4.8 18.3 4.8 16.5 6.6 16.5 6.6 14.7 8.4 14.7 8.4 12.9 10.2 12.9 10.2 11.1 12 11.1 12 9.3 13.8 9.3 13.8 7.5 15.6 7.5 15.6 3.9 4.8 3.9 4.8 2.1 6.6 2.1 6.6 0.3Z"/>',
  true,
);
export const Camera = hero(videoCamera);
export const Hangup = hero(phoneXMark);
export const Users = hero(users);
export const Chevron = hero(chevronDown);
export const Link = hero(link);
export const Compass = hero(globeAlt);
export const Logout = hero(arrowRightStartOnRectangle);
export const Minimize = hero(minus);
export const Minus = hero(minus);
export const Maximize = hero(stop);
const PinIcon = icon(
  path('M9 3.75h6') +
    path('M9.75 3.75v5.1L7.2 11.6a1.5 1.5 0 0 0-.45 1.07v.58h10.5v-.58a1.5 1.5 0 0 0-.45-1.07l-2.55-2.75v-5.1') +
    path('M12 13.25v7'),
);
// Tilted like Discord's pin.
export const Pin = (p: P) => <PinIcon style={{ rotate: '40deg' }} {...p} />;
export const Search = hero(magnifyingGlass);
export const Thread = hero(chatBubbleLeftRight);
export const StreamChat = hero(chatBubbleOvalLeft);
export const Bell = hero(bell);
export const BellOff = hero(bellSlash);
export const UserPlus = hero(userPlus);
export const Download = hero(arrowDownTray);
export const Star = hero(star);
export const Copy = hero(documentDuplicate);
export const Fullscreen = hero(arrowsPointingOut);
export const Back = hero(chevronLeft);
export const At = hero(atSymbol);
export const Eye = hero(eye);
export const EyeOff = hero(eyeSlash);
export const Appearance = hero(swatch);
export const Sun = hero(sun);
export const Moon = hero(moon);
export const Snowflake = icon(
  path(
    'M12 2.25v19.5M3.56 7.13l16.88 9.74M3.56 16.87l16.88-9.74M9.75 3.75 12 6l2.25-2.25M9.75 20.25 12 18l2.25 2.25M3.2 10.2l3.07-.82-.82-3.07M20.8 13.8l-3.07.82.82 3.07M3.2 13.8l3.07.82-.82 3.07M20.8 10.2l-3.07-.82.82-3.07',
  ),
);
export const Switch = hero(arrowsRightLeft);
export const PopOut = icon(
  path(
    'M3.75 5.25h16.5a1.5 1.5 0 0 1 1.5 1.5v10.5a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V6.75a1.5 1.5 0 0 1 1.5-1.5Z',
  ) +
    path(
      'M12.75 12h5.25a.75.75 0 0 1 .75.75v2.25a.75.75 0 0 1-.75.75h-5.25a.75.75 0 0 1-.75-.75v-2.25a.75.75 0 0 1 .75-.75Z',
    ),
);
export const Signal = icon(bars(4));
export const SignalGood = icon(bars(3));
export const SignalOk = icon(bars(2));
export const SignalBad = icon(bars(1));
export const Play = hero(play);
export const Account = hero(userCircle);
export const Keyboard = icon(
  path(
    'M3.75 6.75h16.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5v-7.5a1.5 1.5 0 0 1 1.5-1.5Z',
  ) +
    path(
      'M6 9.75h.008v.008H6v-.008Zm3 0h.008v.008H9v-.008Zm3 0h.008v.008H12v-.008Zm3 0h.008v.008H15v-.008Zm3 0h.008v.008H18v-.008Z',
    ) +
    path(
      'M7.5 12.375h.008v.008H7.5v-.008Zm3 0h.008v.008H10.5v-.008Zm3 0h.008v.008H13.5v-.008Zm3 0h.008v.008H16.5v-.008Z',
    ) +
    path('M8.25 14.625h7.5'),
);
export const AppIcon = hero(windowIcon);
export const AddImage = hero(photo);
export const Photo = hero(camera);
export const Connection = hero(link);
export const Warning = hero(exclamationTriangle);
export const Tune = hero(adjustmentsHorizontal);
export const Check = hero(check);
export const Pause = hero(pause);
export const VolumeMute = hero(speakerXMark);
// Heroicons' speaker without its outer wave.
export const VolumeLow = icon(body(speakerWave).replace('M19.114 5.636a9 9 0 0 1 0 12.728', ''));
export const VolumeHigh = hero(speakerWave);
export const Speed = hero(forward);
export const NextTrack = hero(forward);
export const External = hero(arrowTopRightOnSquare);
export const EnterFullscreen = hero(arrowsPointingOut);
export const ExitFullscreen = hero(arrowsPointingIn);
export const Rejoin = hero(arrowPath);
export const Refresh = hero(arrowPath);
export const ArrowRight = hero(arrowRight);

/** The app icon (assets/icon.png): the Triforce on its dark tile, the same everywhere (window, tray, the app). */
export function Emblem(p: { size?: number; christmas?: boolean }) {
  const festive = () => p.christmas || isChristmas();
  const w = () => p.size ?? 28;
  return (
    <img
      class="emblem"
      src={festive() ? emblemChristmasUrl : emblemUrl}
      width={w()}
      height={festive() ? w() : Math.round((w() * 621) / 827)}
      alt="Linkord"
      draggable={false}
    />
  );
}
export const Send = hero(paperAirplane);
export const Lock = hero(lockClosed);
export const ChevronUpIcon = hero(chevronUp);
export const Folder = hero(folder);
export const FolderOpen = hero(folderOpen);

/**
 * A link's icon: the site's own mark for sites we know (lib/brand-icons.ts: Instagram, Twitter, Steam...), otherwise
 * the chain link. Brand marks fill their whole grid, so they get Heroicons' 2px of air to match in size.
 */
export function SiteIcon(p: { url: string; size?: number; class?: string }) {
  const brand = () => brandOf(p.url);
  return (
    <Show when={brand()} fallback={<Link size={p.size} class={p.class} />}>
      {(b) => (
        <svg
          class={p.class}
          width={p.size ?? 20}
          height={p.size ?? 20}
          viewBox="-2 -2 28 28"
          fill="currentColor"
          role="img"
          aria-label={b().name}
        >
          <path d={b().path} />
        </svg>
      )}
    </Show>
  );
}
