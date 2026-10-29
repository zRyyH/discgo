// Message history per text channel: pages from REST, live updates from the gateway.
import { create } from 'zustand';
import { api } from '../api/rest';
import type { Message, ServerEvent } from '../shared/protocol';

const PAGE = 50;

export interface ChannelHistory {
  /** Oldest first. */
  items: Message[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
}

interface MessagesState {
  byChannel: Record<string, ChannelHistory>;
  load: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  upsert: (m: Message) => void;
  apply: (ev: ServerEvent) => void;
  reset: () => void;
}

const empty: ChannelHistory = { items: [], loaded: false, loading: false, hasMore: true, error: null };

function merge(items: Message[], incoming: Message[]): Message[] {
  const map = new Map(items.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  // UUIDv7 ids sort chronologically.
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const useMessages = create<MessagesState>()((set, get) => {
  const patch = (channelId: string, p: Partial<ChannelHistory>) =>
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: { ...(s.byChannel[channelId] ?? empty), ...p } } }));

  const fetchPage = async (channelId: string, before?: string) => {
    const h = get().byChannel[channelId] ?? empty;
    if (h.loading) return;
    patch(channelId, { loading: true, error: null });
    try {
      const page = await api.messages(channelId, before, PAGE);
      const cur = get().byChannel[channelId] ?? empty;
      patch(channelId, {
        items: merge(cur.items, page),
        loaded: true,
        loading: false,
        hasMore: before || !cur.loaded ? page.length === PAGE : cur.hasMore,
      });
    } catch (e) {
      patch(channelId, { loading: false, error: (e as Error).message });
    }
  };

  return {
    byChannel: {},
    load: (channelId) => fetchPage(channelId),
    loadOlder: async (channelId) => {
      const h = get().byChannel[channelId];
      if (!h?.loaded || !h.hasMore || h.loading || h.items.length === 0) return;
      await fetchPage(channelId, h.items[0].id);
    },
    upsert: (m) => {
      const h = get().byChannel[m.channel_id];
      if (h?.loaded) patch(m.channel_id, { items: merge(h.items, [m]) });
    },
    apply: (ev) => {
      switch (ev.op) {
        case 'ready':
          // Resync: drop cached history; open channels reload it.
          set({ byChannel: {} });
          break;
        case 'message_create':
        case 'message_update':
          get().upsert(ev.d);
          break;
        case 'message_delete': {
          const h = get().byChannel[ev.d.channel_id];
          if (h) patch(ev.d.channel_id, { items: h.items.filter((m) => m.id !== ev.d.id) });
          break;
        }
        case 'channel_delete':
          set((s) => {
            const { [ev.d.id]: _, ...rest } = s.byChannel;
            return { byChannel: rest };
          });
          break;
      }
    },
    reset: () => set({ byChannel: {} }),
  };
});
