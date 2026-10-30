// Voice membership and self state (PLAN 3.1 step 4). The media itself lives in
// media/MediaSession.ts (phase 5); this store only talks to the gateway.
import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { play } from '../lib/sounds';
import type { ServerEvent, VoiceSession } from '../shared/protocol';

interface VoiceStore {
  channelId: string | null;
  session: VoiceSession | null;
  selfMute: boolean;
  selfDeaf: boolean;
  join: (channelId: string) => void;
  leave: () => void;
  toggleMute: () => void;
  toggleDeaf: () => void;
  apply: (ev: ServerEvent, myId: string | undefined) => void;
}

export const useVoice = create<VoiceStore>()((set, get) => {
  const sendState = () => {
    const { selfMute, selfDeaf, channelId } = get();
    if (channelId) gateway.send({ op: 'voice_state', d: { self_mute: selfMute, self_deaf: selfDeaf } });
  };

  return {
    channelId: null,
    session: null,
    selfMute: false,
    selfDeaf: false,
    join: (channelId) => {
      if (get().channelId === channelId) return;
      const { selfMute, selfDeaf } = get();
      if (gateway.send({ op: 'voice_join', d: { channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf } })) {
        set({ channelId, session: null });
        play('join');
      }
    },
    leave: () => {
      if (!get().channelId) return;
      gateway.send({ op: 'voice_leave', d: {} });
      set({ channelId: null, session: null });
      play('leave');
    },
    toggleMute: () => {
      const { selfMute, selfDeaf } = get();
      // Unmuting while deafened also undeafens, like Discord.
      const next = selfDeaf ? { selfMute: false, selfDeaf: false } : { selfMute: !selfMute, selfDeaf };
      set(next);
      play(next.selfMute ? 'mute' : 'unmute');
      sendState();
    },
    toggleDeaf: () => {
      const selfDeaf = !get().selfDeaf;
      set({ selfDeaf, selfMute: selfDeaf ? true : false });
      play(selfDeaf ? 'mute' : 'unmute');
      sendState();
    },
    apply: (ev, myId) => {
      switch (ev.op) {
        case 'ready': {
          // After a reconnect, take our place back (the server kept it for 10 s).
          const { channelId, selfMute, selfDeaf , session } = get();
          const target = channelId ?? ev.d.voice_session?.channel_id ?? null;
          if (target) {
            // Naming the session we still have media for keeps it; without one (app just
            // started, e.g. after an update) the server starts a fresh one for both peers.
            const d = { channel_id: target, self_mute: selfMute, self_deaf: selfDeaf, session_id: session?.session_id };
            gateway.send({ op: 'voice_join', d });
            set({ channelId: target });
          }
          break;
        }
        case 'voice_session':
          if (ev.d.channel_id === get().channelId) set({ session: ev.d });
          break;
        case 'voice_state_update':
          // The server removed us (grace period expired, channel deleted).
          if (ev.d.user_id === myId && !ev.d.channel_id && get().channelId) set({ channelId: null, session: null });
          break;
        case 'channel_delete':
          if (ev.d.id === get().channelId) set({ channelId: null, session: null });
          break;
      }
    },
  };
});
