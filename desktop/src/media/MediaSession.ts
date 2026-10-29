// One transport for a voice channel (PLAN 7.3): P2P (RTCPeerConnection with
// the single peer) or SFU (LiveKit). voice.ts swaps implementations whenever
// the server sends a new voice_session; local tracks survive the swap.
import type { EngineTarget } from '../shared/engine';

export type RemoteKind = 'mic' | 'cam' | 'screen' | 'screen_audio';

export interface RemoteMedia {
  /** Stable while the track lives. */
  id: string;
  userId: string;
  kind: RemoteKind;
  track: MediaStreamTrack;
  /** False while the sender has paused it (camera off). */
  live: boolean;
  receiver?: RTCRtpReceiver;
  attach(el: HTMLMediaElement): void;
  detach(el: HTMLMediaElement): void;
}

export type SessionState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface SessionStats {
  rttMs: number | null;
  /** Average jitter-buffer delay of received audio over the last second. */
  audioJitterMs: number | null;
  audioLoss: number | null;
  outKbps: number | null;
  inKbps: number | null;
  candidate: string | null;
}

export interface MediaEvents {
  track: (m: RemoteMedia) => void;
  trackUpdate: (m: RemoteMedia) => void;
  trackEnded: (id: string) => void;
  speaking: (userIds: string[]) => void;
  state: (s: SessionState) => void;
}

export interface MediaSession {
  readonly mode: 'p2p' | 'sfu';
  connect(): Promise<void>;
  close(): Promise<void>;
  setMic(track: MediaStreamTrack | null): Promise<void>;
  setCamera(track: MediaStreamTrack | null): Promise<void>;
  stats(): Promise<SessionStats>;
  screenTarget(): EngineTarget | null;
}

/** Minimal typed event emitter shared by the session implementations. */
export class Emitter {
  // One map for every event signature; on()/emit() keep the public API typed.
  private handlers = new Map<keyof MediaEvents, Set<(...args: any[]) => void>>();
  on<K extends keyof MediaEvents>(event: K, cb: MediaEvents[K]): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }
  emit<K extends keyof MediaEvents>(event: K, ...args: Parameters<MediaEvents[K]>) {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: Parameters<MediaEvents[K]>) => void)(...args);
  }
}
