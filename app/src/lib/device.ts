// What a login is running on, from what its gateway connection said about itself (Settings -> Sessions).

export interface Device {
  /** The desktop app, not a browser. */
  app: boolean;
  browser: string | null;
  os: string | null;
  mobile: boolean;
}

// The order matters: Edge and Opera also say Chrome and Safari, Android also says Linux, iPhones also say Mac OS.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(HeadlessChrome|Chrome|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, 'Windows'],
  [/\bAndroid\b/, 'Android'],
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const first = (list: [RegExp, string][], text: string) => list.find(([re]) => re.test(text))?.[1] ?? null;

export function describeDevice(client: string | null | undefined, userAgent: string | null | undefined): Device {
  const ua = userAgent ?? '';
  // The desktop app and the Android app (android/) are apps, not browsers.
  const app = client === 'desktop' || client === 'android';
  return {
    app,
    browser: app ? null : first(BROWSERS, ua),
    os: first(SYSTEMS, ua),
    mobile: /\b(Android|iPhone|iPad|Mobile)\b/.test(ua),
  };
}
