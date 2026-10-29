// Transient UI state (not persisted).
import { create } from 'zustand';

type SettingsSection = 'account' | 'voice' | 'notifications' | 'invites' | 'channels' | 'members';

interface UiState {
  channelId: string | null;
  editingId: string | null;
  settingsOpen: SettingsSection | null;
  selectChannel: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  openSettings: (section: SettingsSection | null) => void;
}

export const useUi = create<UiState>()((set) => ({
  channelId: null,
  editingId: null,
  settingsOpen: null,
  selectChannel: (channelId) => set({ channelId, editingId: null }),
  setEditing: (editingId) => set({ editingId }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
}));

export type { SettingsSection };
