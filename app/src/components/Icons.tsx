// UI icons from Lucide (ISC license), under the names the components use. The Linkord emblem is our own.
import type { JSX } from 'solid-js';
import AtSign from 'lucide-solid/icons/at-sign';
import LBell from 'lucide-solid/icons/bell';
import LBellOff from 'lucide-solid/icons/bell-off';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import LCompass from 'lucide-solid/icons/compass';
import LCopy from 'lucide-solid/icons/copy';
import LDownload from 'lucide-solid/icons/download';
import Expand from 'lucide-solid/icons/expand';
import ArrowLeftRight from 'lucide-solid/icons/arrow-left-right';
import LEye from 'lucide-solid/icons/eye';
import Gamepad2 from 'lucide-solid/icons/gamepad-2';
import LHash from 'lucide-solid/icons/hash';
import HeadphoneOff from 'lucide-solid/icons/headphone-off';
import LHeadphones from 'lucide-solid/icons/headphones';
import ImagePlay from 'lucide-solid/icons/image-play';
import LLink from 'lucide-solid/icons/link';
import LogOut from 'lucide-solid/icons/log-out';
import MessagesSquare from 'lucide-solid/icons/messages-square';
import LMic from 'lucide-solid/icons/mic';
import LMicOff from 'lucide-solid/icons/mic-off';
import Minus from 'lucide-solid/icons/minus';
import LPaperclip from 'lucide-solid/icons/paperclip';
import Pencil from 'lucide-solid/icons/pencil';
import SquarePen from 'lucide-solid/icons/square-pen';
import Languages from 'lucide-solid/icons/languages';
import PhoneOff from 'lucide-solid/icons/phone-off';
import PictureInPicture2 from 'lucide-solid/icons/picture-in-picture-2';
import LPin from 'lucide-solid/icons/pin';
import LPlus from 'lucide-solid/icons/plus';
import LReply from 'lucide-solid/icons/reply';
import ScreenShare from 'lucide-solid/icons/screen-share';
import LSearch from 'lucide-solid/icons/search';
import Settings from 'lucide-solid/icons/settings';
import LSignal from 'lucide-solid/icons/signal';
import SignalHigh from 'lucide-solid/icons/signal-high';
import SignalLow from 'lucide-solid/icons/signal-low';
import SignalMedium from 'lucide-solid/icons/signal-medium';
import LSmile from 'lucide-solid/icons/face-slightly-smiling';
import Square from 'lucide-solid/icons/square';
import LStar from 'lucide-solid/icons/star';
import Trash2 from 'lucide-solid/icons/trash';
import LUserPlus from 'lucide-solid/icons/user-plus';
import LUsers from 'lucide-solid/icons/users';
import Video from 'lucide-solid/icons/video';
import Volume2 from 'lucide-solid/icons/volume-2';
import X from 'lucide-solid/icons/x';
import LPlay from 'lucide-solid/icons/play';
import CircleUser from 'lucide-solid/icons/circle-user';
import LKeyboard from 'lucide-solid/icons/keyboard';
import AppWindow from 'lucide-solid/icons/app-window';
import ImagePlus from 'lucide-solid/icons/image-plus';
import LCamera from 'lucide-solid/icons/camera';
import Link2 from 'lucide-solid/icons/link-2';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import Sliders from 'lucide-solid/icons/sliders-horizontal';
import LCheck from 'lucide-solid/icons/check';
import LPause from 'lucide-solid/icons/pause';
import VolumeX from 'lucide-solid/icons/volume-x';
import Volume1 from 'lucide-solid/icons/volume-1';
import Gauge from 'lucide-solid/icons/gauge';
import ExternalLink from 'lucide-solid/icons/external-link';
import LMaximize from 'lucide-solid/icons/maximize';
import LMinimize from 'lucide-solid/icons/minimize';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import SendHorizontal from 'lucide-solid/icons/send-horizontal';
import LLock from 'lucide-solid/icons/lock';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import LFolder from 'lucide-solid/icons/folder';
import LFolderOpen from 'lucide-solid/icons/folder-open';

type P = { size?: number } & JSX.SvgSVGAttributes<SVGSVGElement>;

// Slightly lighter strokes than Lucide's default suit the theme.
const icon = (C: (p: any) => JSX.Element) => (p: P) => <C size={p.size ?? 20} stroke-width={1.8} {...p} />;

export const Hash = icon(LHash);
export const Speaker = icon(Volume2);
export const Mic = icon(LMic);
export const MicOff = icon(LMicOff);
export const Headphones = icon(LHeadphones);
export const HeadphonesOff = icon(HeadphoneOff);
export const Gear = icon(Settings);
export const Plus = icon(LPlus);
export const Close = icon(X);
export const Reply = icon(LReply);
export const Edit = icon(Pencil);
export const EditProfile = icon(SquarePen);
export const Language = icon(Languages);
export const Trash = icon(Trash2);
export const Smile = icon(LSmile);
export const Paperclip = icon(LPaperclip);
export const Screen = icon(ScreenShare);
export const Gamepad = icon(Gamepad2);
export const Camera = icon(Video);
export const Hangup = icon(PhoneOff);
export const Users = icon(LUsers);
export const Chevron = icon(ChevronDown);
export const Link = icon(LLink);
export const Compass = icon(LCompass);
export const Logout = icon(LogOut);
export const Minimize = icon(Minus);
export const Maximize = icon(Square);
export const Pin = icon(LPin);
export const Search = icon(LSearch);
export const Thread = icon(MessagesSquare);
export const Bell = icon(LBell);
export const BellOff = icon(LBellOff);
export const UserPlus = icon(LUserPlus);
export const Download = icon(LDownload);
export const Star = icon(LStar);
export const Copy = icon(LCopy);
export const Gif = icon(ImagePlay);
export const Fullscreen = icon(Expand);
export const Back = icon(ChevronLeft);
export const At = icon(AtSign);
export const Eye = icon(LEye);
export const Switch = icon(ArrowLeftRight);
export const PopOut = icon(PictureInPicture2);
export const Signal = icon(LSignal);
export const SignalGood = icon(SignalHigh);
export const SignalOk = icon(SignalMedium);
export const SignalBad = icon(SignalLow);
export const Play = icon(LPlay);
export const Account = icon(CircleUser);
export const Keyboard = icon(LKeyboard);
export const AppIcon = icon(AppWindow);
export const AddImage = icon(ImagePlus);
export const Photo = icon(LCamera);
export const Connection = icon(Link2);
export const Warning = icon(TriangleAlert);
export const Tune = icon(Sliders);
export const Check = icon(LCheck);
export const Pause = icon(LPause);
export const VolumeMute = icon(VolumeX);
export const VolumeLow = icon(Volume1);
export const VolumeHigh = icon(Volume2);
export const Speed = icon(Gauge);
export const External = icon(ExternalLink);
export const EnterFullscreen = icon(LMaximize);
export const ExitFullscreen = icon(LMinimize);
export const Rejoin = icon(RefreshCw);

/** The Linkord emblem: three corner shards around a link ring. */
/** The Triforce, in the one accent gold. */
export function Emblem(p: { size?: number }) {
  return (
    <svg width={p.size ?? 28} height={((p.size ?? 28) * 173.2) / 200} viewBox="0 0 200 173.2" aria-label="Linkord" style={{ fill: 'var(--gold, #e3b341)' }}>
      <path d="M100 0 150 86.6H50Z" />
      <path d="M50 86.6 100 173.2H0Z" />
      <path d="M150 86.6 200 173.2H100Z" />
    </svg>
  );
}
export const Send = icon(SendHorizontal);
export const Lock = icon(LLock);
export const ChevronUpIcon = icon(ChevronUp);
export const Folder = icon(LFolder);
export const FolderOpen = icon(LFolderOpen);
