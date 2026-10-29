// Who is talking right now (PLAN 7.4): set by the active media session.
import { create } from 'zustand';

interface SpeakingState {
  ids: Set<string>;
  set: (ids: string[]) => void;
}

export const useSpeaking = create<SpeakingState>()((set, get) => ({
  ids: new Set(),
  set: (ids) => {
    const cur = get().ids;
    if (ids.length === cur.size && ids.every((id) => cur.has(id))) return;
    set({ ids: new Set(ids) });
  },
}));
