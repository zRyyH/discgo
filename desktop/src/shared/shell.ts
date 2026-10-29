// Thin wrapper over the desktop shell (PLAN 7.2). Everything the UI needs from
// Tauri goes through here so the shell stays swappable.
import { getCurrentWindow } from '@tauri-apps/api/window';

const win = getCurrentWindow();

export const windowControls = {
  minimize: () => win.minimize(),
  toggleMaximize: () => win.toggleMaximize(),
  close: () => win.close(),
  isMaximized: () => win.isMaximized(),
  onResized: (cb: () => void) => win.onResized(cb),
};
