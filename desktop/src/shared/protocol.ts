// REST and gateway shapes (PLAN 5.2, 5.3). Mirror of api/internal/protocol —
// the wire contract is api/internal/protocol/testdata/*.json.

export interface User {
  id: string;
  /** The Gmail address without "@gmail.com" (whole address for other domains). */
  username: string;
  display_name: string;
  avatar_url: string;
  role: 'admin' | 'member';
}

export interface Me extends User {
  email: string;
}

export interface Member extends User {
  status: 'online' | 'offline';
}

export interface Channel {
  id: string;
  kind: 'text' | 'voice';
  name: string;
  position: number;
}

export interface Attachment {
  key: string;
  name: string;
  content_type: string;
  size: number;
  width?: number;
  height?: number;
  url?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  attachments: Attachment[];
  created_at: string;
  edited_at: string | null;
}

/** A friend or a pending friend request, seen from the current user. */
export interface Relationship {
  user: User;
  type: 'friend' | 'incoming' | 'outgoing';
  since: string;
}

export interface VoiceState {
  user_id: string;
  channel_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
}

export interface VoiceSession {
  channel_id: string;
  session_id: string;
  mode: 'idle' | 'p2p' | 'sfu';
  peer_user_id?: string;
  polite?: boolean;
  livekit_url?: string;
}

export interface RtcSignal {
  session_id: string;
  to_user_id?: string;
  from_user_id?: string;
  stream: 'av' | 'screen';
  type: 'offer' | 'answer' | 'ice';
  payload: unknown;
}

export interface Ready {
  user: Me;
  community: { name: string };
  members: Member[];
  channels: Channel[];
  voice_states: VoiceState[];
  voice_session: VoiceSession | null;
  relationships: Relationship[];
}

/** A newer app version is published (PLAN fase 9A); the signed updater does the rest. */
export interface AppUpdate {
  version: string;
  notes: string;
}

export type ServerEvent =
  | { op: 'ready'; d: Ready }
  | { op: 'message_create' | 'message_update'; d: Message }
  | { op: 'message_delete'; d: { id: string; channel_id: string } }
  | { op: 'channel_create' | 'channel_update'; d: Channel }
  | { op: 'channel_delete'; d: { id: string } }
  | { op: 'member_add'; d: Member }
  | { op: 'member_update'; d: User }
  | { op: 'presence_update'; d: { user_id: string; status: Member['status'] } }
  | { op: 'voice_state_update'; d: VoiceState }
  | { op: 'voice_session'; d: VoiceSession }
  | { op: 'rtc_signal'; d: RtcSignal }
  | { op: 'relationship_add'; d: Relationship }
  | { op: 'relationship_remove'; d: { user_id: string } }
  | { op: 'app_update'; d: AppUpdate }
  | { op: 'pong'; d: unknown }
  | { op: 'error'; d: { code: string; message: string } };

export type ClientEvent =
  | { op: 'identify'; d: { token: string; client: { version: string; p2p: boolean } } }
  // session_id: the session we still have media for, when rejoining after a reconnect.
  | { op: 'voice_join'; d: { channel_id: string; self_mute: boolean; self_deaf: boolean; session_id?: string } }
  | { op: 'voice_leave'; d: Record<string, never> }
  | { op: 'voice_state'; d: { self_mute: boolean; self_deaf: boolean } }
  | { op: 'rtc_signal'; d: RtcSignal }
  | { op: 'p2p_failed'; d: { session_id: string; reason: string } }
  | { op: 'ping'; d: unknown };
