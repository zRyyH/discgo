// Thin wrapper over the desktop shell (PLAN 7.2). Everything the UI needs from
// Tauri goes through here so the shell stays swappable. Outside Tauri (the UI
// opened in a plain browser during development, e.g. as extra call participants)
// it falls back to browser equivalents.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { load, type Store } from '@tauri-apps/plugin-store';
import type { EngineCommand, EngineEvent } from './engine';

export const inTauri = '__TAURI_INTERNALS__' in window;

const win = inTauri ? getCurrentWindow() : null;
const noop = async () => {};

export const windowControls = {
  minimize: () => win?.minimize() ?? noop(),
  toggleMaximize: () => win?.toggleMaximize() ?? noop(),
  close: () => win?.close() ?? noop(),
  isMaximized: () => win?.isMaximized() ?? Promise.resolve(false),
  onResized: (cb: () => void) => win?.onResized(cb) ?? Promise.resolve(() => {}),
};

// Browser fallback is per tab, so several dev users can run side by side.
const SESSION_KEY = 'discgo.session';
export const session = {
  get: () => (inTauri ? invoke<string | null>('session_get') : Promise.resolve(sessionStorage.getItem(SESSION_KEY))),
  set: (token: string) =>
    inTauri ? invoke<void>('session_set', { token }) : Promise.resolve(sessionStorage.setItem(SESSION_KEY, token)),
  clear: () => (inTauri ? invoke<void>('session_clear') : Promise.resolve(sessionStorage.removeItem(SESSION_KEY))),
};

export const openExternal = (url: string) =>
  inTauri ? invoke<void>('open_external', { url }) : Promise.resolve(void window.open(url, '_blank', 'noopener'));
export const appVersion = () => (inTauri ? invoke<string>('app_version') : Promise.resolve('dev-browser'));

/** Calls cb for every discgo:// URL: the one that launched the app and later ones. */
export async function onDeepLink(cb: (url: URL) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const handle = (urls: string[] | null) => urls?.forEach((u) => cb(new URL(u)));
  const unlisten = await onOpenUrl(handle);
  handle(await getCurrent());
  return unlisten;
}

let settingsStore: Promise<Store> | null = null;
export const settings = {
  store: () => (settingsStore ??= load('settings.json', { defaults: {}, autoSave: 300 })),
  async get<T>(key: string): Promise<T | undefined> {
    if (!inTauri) {
      const v = sessionStorage.getItem('discgo.' + key);
      return v ? (JSON.parse(v) as T) : undefined;
    }
    return (await settings.store()).get<T>(key);
  },
  async set(key: string, value: unknown) {
    if (!inTauri) return sessionStorage.setItem('discgo.' + key, JSON.stringify(value));
    await (await settings.store()).set(key, value);
  },
  /** Writes pending changes now (autosave is debounced), e.g. right before the app exits. */
  async flush() {
    if (inTauri) await (await settings.store()).save();
  },
};

// --- capture engine sidecar (PLAN 6.8) ---

export const engine = {
  available: inTauri,
  start: () => invoke<void>('engine_start'),
  send: (cmd: EngineCommand) => invoke<void>('engine_send', { line: JSON.stringify(cmd) }),
  /** Resolves to whether the engine was running; `onExit` fires once it is gone. */
  stop: () => invoke<boolean>('engine_stop'),
  onEvent: (cb: (e: EngineEvent) => void) =>
    listen<string>('engine://event', (e) => {
      try {
        cb(JSON.parse(e.payload) as EngineEvent);
      } catch {
        /* not a protocol line */
      }
    }),
  onExit: (cb: (code: number | null) => void) => listen<number | null>('engine://exit', (e) => cb(e.payload)),
};

export const keepDisplayOn = (on: boolean) => (inTauri ? invoke<void>('power_keep_display', { on }) : Promise.resolve());
