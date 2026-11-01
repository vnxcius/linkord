/** The parts of a MediaDeviceInfo used to pair a capture card's picture with its sound. */
export interface DeviceLike {
  deviceId: string;
  groupId: string;
  label: string;
}

/** Chromium ends USB device labels with "(vendor:product)". */
const usbId = (label: string) => label.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i)?.[1].toLowerCase() ?? null;

/**
 * A capture card shows up as a camera plus a separate audio input: finds that input for a video device, by the
 * browser's group id or else the USB id in the label. `inputs` must not hold the "default"/"communications" entries:
 * they repeat a real device's group id, and those ids follow the Windows default.
 */
export function matchCaptureAudio<T extends DeviceLike>(video: DeviceLike, inputs: T[]): T | null {
  const id = usbId(video.label);
  return (
    (video.groupId && inputs.find((i) => i.groupId === video.groupId)) ||
    (id && inputs.find((i) => usbId(i.label) === id)) ||
    null
  );
}
