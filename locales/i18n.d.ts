/**
 * Types for `i18n.js`, hand-written because the engine is plain JS on purpose:
 * the browser imports the same file the Node side does, so it cannot be `.ts`
 * (there is no build step) — and `allowJs` would type it as `any` anyway.
 */

/** Placeholder values. `n` additionally selects the plural form. */
export interface TParams {
  [name: string]: string | number | null | undefined;
  n?: number;
}

export type Translator = (key: string, params?: TParams) => string;

export interface Formatters {
  locale: string;
  n: (v: number | null | undefined) => string;
  date: (ts: number | Date) => string;
  dateTime: (ts: number | Date) => string;
  time: (ts: number | Date) => string;
  full: (ts: number | Date) => string;
}

export function createTranslator(
  locale: string,
  catalog: unknown,
  onMissing?: (key: string) => void,
): Translator;

export function createFormatters(locale: string): Formatters;
