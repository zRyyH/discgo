// User preferences, persisted with tauri-plugin-store (settings.json).
import { create } from 'zustand';
import { settings as store } from '../shared/shell';

export interface Settings {
  sounds: boolean;
  showMembers: boolean;
  lastTextChannel: string | null;
  inputDeviceId: string;
  outputDeviceId: string;
  videoDeviceId: string;
  highQualityVoice: boolean;
  userVolumes: Record<string, number>;
  /** PLAN fase 9D: the window's X hides it in the tray. */
  closeToTray: boolean;
  startWithWindows: boolean;
}

const defaults: Settings = {
  sounds: true,
  showMembers: true,
  lastTextChannel: null,
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: '',
  highQualityVoice: false,
  userVolumes: {},
  closeToTray: true,
  startWithWindows: true,
};

interface SettingsState extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  ...defaults,
  loaded: false,
  load: async () => {
    const saved = (await store.get<Partial<Settings>>('prefs').catch(() => undefined)) ?? {};
    set({ ...defaults, ...saved, loaded: true });
  },
  update: (patch) => {
    set(patch);
    const { loaded: _loaded, load: _load, update: _update, ...prefs } = { ...get(), ...patch };
    void store.set('prefs', prefs).catch(() => {});
  },
}));
