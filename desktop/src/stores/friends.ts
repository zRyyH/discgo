// Friends and pending friend requests of the current user, fed by the gateway:
// `ready` replaces them, relationship_add / relationship_remove patch them.
import { create } from 'zustand';
import type { Relationship, ServerEvent } from '../shared/protocol';

interface FriendsState {
  /** By the other user's id. */
  relationships: Record<string, Relationship>;
  apply: (ev: ServerEvent) => void;
  reset: () => void;
}

export const useFriends = create<FriendsState>()((set) => ({
  relationships: {},
  reset: () => set({ relationships: {} }),
  apply: (ev) =>
    set((s): Partial<FriendsState> => {
      switch (ev.op) {
        case 'ready':
          return { relationships: Object.fromEntries(ev.d.relationships.map((r) => [r.user.id, r])) };
        case 'relationship_add':
          return { relationships: { ...s.relationships, [ev.d.user.id]: ev.d } };
        case 'relationship_remove': {
          if (!s.relationships[ev.d.user_id]) return {};
          const relationships = { ...s.relationships };
          delete relationships[ev.d.user_id];
          return { relationships };
        }
        case 'member_update': {
          const r = s.relationships[ev.d.id];
          return r ? { relationships: { ...s.relationships, [ev.d.id]: { ...r, user: ev.d } } } : {};
        }
        default:
          return {};
      }
    }),
}));

/** Friend requests waiting for our answer (the badge in the sidebar). */
export const useIncomingCount = () =>
  useFriends((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
