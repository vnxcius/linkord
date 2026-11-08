// Opening the devices the user picked (mic, camera, speakers), falling back to the system default when they're gone.
import { prefs } from './prefs';

/**
 * The chosen input device by its exact id, or the system default if that fails. Device ids disappear or change when
 * a device is unplugged or a Bluetooth headset switches profile (stereo A2DP has no mic; the hands-free endpoint is a
 * separate device), and an `exact` id that no longer exists makes getUserMedia throw, leaving the call without a mic.
 */
export async function getMic(audio: MediaTrackConstraints): Promise<MediaStream> {
  const id = prefs.inputDevice;
  if (id && id !== 'default') {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: id } } });
    } catch (e) {
      // No permission is no permission on every device; anything else, try the default.
      if ((e as DOMException)?.name === 'NotAllowedError') throw e;
      console.warn('chosen microphone unavailable, using the default', e);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

/** Whether a live mic track is the device the user picked (always true for "System default"). */
export function isChosenMic(track: MediaStreamTrack | undefined) {
  const id = prefs.inputDevice;
  return !id || id === 'default' || track?.getSettings().deviceId === id;
}

/** The chosen camera, or the default one if it's unplugged (an `exact` id that's gone makes getUserMedia throw). */
export async function getCamera(video: MediaTrackConstraints): Promise<MediaStream> {
  const id = prefs.videoDevice;
  if (id && id !== 'default') {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: { exact: id } } });
    } catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') throw e;
      console.warn('chosen camera unavailable, using the default', e);
    }
  }
  return navigator.mediaDevices.getUserMedia({ video });
}

/** The sink id for AudioContext.setSinkId: the chosen speakers, or '' (system default) while they aren't connected. */
export async function outputSinkId(): Promise<string> {
  const id = prefs.outputDevice;
  if (!id || id === 'default') return '';
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  return devices.some((d) => d.kind === 'audiooutput' && d.deviceId === id) ? id : '';
}
