// Transient UI state (not persisted).
import { create } from 'zustand';

type SettingsSection = 'account' | 'voice' | 'notifications' | 'invites' | 'channels' | 'members';

interface UiState {
  channelId: string | null;
  /** Center pane: the text channel, or the call stage of the joined voice channel. */
  view: 'chat' | 'call';
  editingId: string | null;
  settingsOpen: SettingsSection | null;
  debugOpen: boolean;
  /** Opens a text channel; `openChat: false` only changes the selection (default channel). */
  selectChannel: (id: string | null, openChat?: boolean) => void;
  setView: (view: 'chat' | 'call') => void;
  setEditing: (id: string | null) => void;
  openSettings: (section: SettingsSection | null) => void;
  toggleDebug: () => void;
}

export const useUi = create<UiState>()((set) => ({
  channelId: null,
  view: 'chat',
  editingId: null,
  settingsOpen: null,
  debugOpen: false,
  selectChannel: (channelId, openChat = true) => set((s) => ({ channelId, editingId: null, view: openChat ? 'chat' : s.view })),
  setView: (view) => set({ view }),
  setEditing: (editingId) => set({ editingId }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
}));

export type { SettingsSection };
