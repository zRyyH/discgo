// Community state fed by the gateway: `ready` replaces everything, events patch it.
import { create } from 'zustand';
import type { Channel, Me, Member, ServerEvent, VoiceState } from '../shared/protocol';
import type { GatewayStatus } from '../api/gateway';

interface CommunityState {
  ready: boolean;
  status: GatewayStatus;
  name: string;
  me: Me | null;
  members: Record<string, Member>;
  channels: Channel[];
  voiceStates: Record<string, VoiceState>;
  apply: (ev: ServerEvent) => void;
  setStatus: (s: GatewayStatus) => void;
  reset: () => void;
}

const initial = {
  ready: false,
  status: 'idle' as GatewayStatus,
  name: '',
  me: null,
  members: {},
  channels: [],
  voiceStates: {},
};

const byPosition = (a: Channel, b: Channel) => a.position - b.position || a.id.localeCompare(b.id);

export const useCommunity = create<CommunityState>()((set) => ({
  ...initial,
  setStatus: (status) => set({ status }),
  reset: () => set(initial),
  apply: (ev) =>
    set((s): Partial<CommunityState> => {
      switch (ev.op) {
        case 'ready': {
          const members: Record<string, Member> = {};
          for (const m of ev.d.members) members[m.id] = m;
          const voiceStates: Record<string, VoiceState> = {};
          for (const v of ev.d.voice_states) voiceStates[v.user_id] = v;
          return {
            ready: true,
            name: ev.d.community.name,
            me: ev.d.user,
            members,
            channels: [...ev.d.channels].sort(byPosition),
            voiceStates,
          };
        }
        case 'channel_create':
        case 'channel_update':
          return { channels: [...s.channels.filter((c) => c.id !== ev.d.id), ev.d].sort(byPosition) };
        case 'channel_delete':
          return { channels: s.channels.filter((c) => c.id !== ev.d.id) };
        case 'member_add':
          return { members: { ...s.members, [ev.d.id]: ev.d } };
        case 'member_update': {
          const prev = s.members[ev.d.id];
          const me = s.me?.id === ev.d.id ? { ...s.me, ...ev.d } : s.me;
          return { me, members: { ...s.members, [ev.d.id]: { ...ev.d, status: prev?.status ?? 'offline' } } };
        }
        case 'presence_update': {
          const prev = s.members[ev.d.user_id];
          return prev ? { members: { ...s.members, [ev.d.user_id]: { ...prev, status: ev.d.status } } } : {};
        }
        case 'voice_state_update': {
          const voiceStates = { ...s.voiceStates };
          if (ev.d.channel_id) voiceStates[ev.d.user_id] = ev.d;
          else delete voiceStates[ev.d.user_id];
          return { voiceStates };
        }
        default:
          return {};
      }
    }),
}));
