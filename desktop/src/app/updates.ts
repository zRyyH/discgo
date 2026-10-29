// Auto-update (PLAN 2, 8): tauri-plugin-updater reads latest.json from the releases
// bucket; packages are verified against the minisign public key in tauri.conf.json.
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { inTauri } from '../shared/shell';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

interface UpdateState {
  available: Update | null;
  installing: boolean;
  error: string | null;
  install: () => Promise<void>;
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  available: null,
  installing: false,
  error: null,
  install: async () => {
    const u = get().available;
    if (!u) return;
    set({ installing: true, error: null });
    try {
      await u.downloadAndInstall();
      await relaunch();
    } catch (e) {
      set({ installing: false, error: String(e) });
    }
  },
}));

async function checkOnce() {
  try {
    const u = await check();
    if (u) useUpdate.setState({ available: u });
  } catch {
    /* offline or no release published yet */
  }
}

export function startUpdateChecks() {
  if (!inTauri || import.meta.env.DEV) return;
  void checkOnce();
  setInterval(() => void checkOnce(), CHECK_EVERY_MS);
}
