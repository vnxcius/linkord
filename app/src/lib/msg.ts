// Marks a string for translation where it's defined (module constants, tables); call t() on it
// where it's shown. Kept apart from i18n.ts so modules that prefs.ts imports can use it too.
export const msg = (text: string) => text;
