// Call through the SFU (PLAN 7.4): livekit-client with adaptive stream, dynacast,
// DTX + RED audio and H.264 simulcast camera. We publish our own MediaStreamTracks
// so the mic survives a P2P ⇄ SFU switch. A screen share is a second participant
// "{user_id}#screen" (published by the engine) and is grouped under its owner.
import {
  ConnectionState,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import type { EngineTarget } from '../shared/engine';
import { Emitter, type MediaSession, type RemoteKind, type RemoteMedia, type SessionStats } from './MediaSession';

export interface SfuOptions {
  selfId: string;
  url: string;
  token: string;
  screenToken: () => Promise<string>;
  voiceKbps: number;
}

const ownerOf = (identity: string) => identity.split('#')[0];

function kindOf(p: RemoteParticipant, t: RemoteTrack): RemoteKind {
  if (p.identity.endsWith('#screen')) return t.kind === Track.Kind.Video ? 'screen' : 'screen_audio';
  if (t.source === Track.Source.ScreenShare) return 'screen';
  if (t.source === Track.Source.ScreenShareAudio) return 'screen_audio';
  return t.kind === Track.Kind.Video ? 'cam' : 'mic';
}

export class SfuSession extends Emitter implements MediaSession {
  readonly mode = 'sfu' as const;
  private room: Room;
  private mic: MediaStreamTrack | null = null;
  private cam: MediaStreamTrack | null = null;
  private remote = new Map<string, RemoteMedia>();
  private screenTok: string | null = null;
  private prevBytes = { out: 0, in: 0, at: 0 };

  constructor(private o: SfuOptions) {
    super();
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
      publishDefaults: {
        dtx: true,
        red: true,
        audioPreset: { maxBitrate: o.voiceKbps * 1000 },
        simulcast: true,
        videoCodec: 'h264',
      },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    });
    this.room
      .on(RoomEvent.TrackSubscribed, (t, pub, p) => this.onSubscribed(t, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (t, _pub, p) => this.onUnsubscribed(t, p))
      .on(RoomEvent.TrackMuted, (pub, p) => this.onMuted(pub, p, false))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.onMuted(pub, p, true))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
        this.emit('speaking', [...new Set(speakers.map((s) => ownerOf(s.identity)))]),
      )
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        if (s === ConnectionState.Connected) this.emit('state', 'connected');
        else if (s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting) this.emit('state', 'reconnecting');
      })
      .on(RoomEvent.Disconnected, () => this.emit('state', 'closed'));
  }

  async connect() {
    this.emit('state', 'connecting');
    await this.room.connect(this.o.url, this.o.token, { autoSubscribe: true });
    if (this.mic) await this.publish(this.mic, Track.Source.Microphone);
    if (this.cam) await this.publish(this.cam, Track.Source.Camera);
    this.emit('state', 'connected');
  }

  async close() {
    for (const id of this.remote.keys()) this.emit('trackEnded', id);
    this.remote.clear();
    // Our tracks are owned by voice.ts and reused by the next session.
    await this.room.disconnect(false);
  }

  async setMic(track: MediaStreamTrack | null) {
    if (this.mic === track) return;
    if (this.mic) await this.unpublish(this.mic);
    this.mic = track;
    if (track && this.room.state === ConnectionState.Connected) await this.publish(track, Track.Source.Microphone);
  }

  async setCamera(track: MediaStreamTrack | null) {
    if (this.cam === track) return;
    if (this.cam) await this.unpublish(this.cam);
    this.cam = track;
    if (track && this.room.state === ConnectionState.Connected) await this.publish(track, Track.Source.Camera);
  }

  screenTarget(): EngineTarget | null {
    return this.screenTok ? { kind: 'livekit', url: this.o.url, token: this.screenTok } : null;
  }

  /** Fetches the "#screen" identity token before starting a share. */
  async prepareScreen(): Promise<EngineTarget> {
    this.screenTok = await this.o.screenToken();
    return { kind: 'livekit', url: this.o.url, token: this.screenTok };
  }

  /** Last-resort share from the WebView itself (PLAN 6.9), when the engine cannot run. */
  async publishScreen(track: MediaStreamTrack | null) {
    const pubs = [...this.room.localParticipant.trackPublications.values()];
    for (const p of pubs) if (p.source === Track.Source.ScreenShare && p.track) await this.unpublish(p.track.mediaStreamTrack);
    if (track)
      await this.room.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShare,
        videoCodec: 'h264',
        simulcast: false,
        screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
      });
  }

  async stats(): Promise<SessionStats> {
    const out: SessionStats = { rttMs: null, audioJitterMs: null, audioLoss: null, outKbps: null, inKbps: null, candidate: null };
    const pubs = [...this.room.localParticipant.trackPublications.values()];
    const sender = pubs.find((p) => p.track?.sender)?.track?.sender;
    if (sender) {
      const report = await sender.getStats();
      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) {
          out.rttMs = Math.round(s.currentRoundTripTime * 1000);
          const now = performance.now();
          if (this.prevBytes.at) out.outKbps = Math.round(((s.bytesSent - this.prevBytes.out) * 8) / ((now - this.prevBytes.at) / 1000) / 1000);
          this.prevBytes = { ...this.prevBytes, out: s.bytesSent, at: now };
          out.candidate = 'sfu';
        }
      });
    }
    let jitter = 0;
    let n = 0;
    for (const m of this.remote.values()) {
      if (m.kind !== 'mic' || !m.receiver) continue;
      (await m.receiver.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.jitterBufferEmittedCount) {
          jitter += s.jitterBufferDelay / s.jitterBufferEmittedCount;
          n++;
        }
      });
    }
    if (n) out.audioJitterMs = Math.round((jitter / n) * 1000);
    return out;
  }

  private async publish(track: MediaStreamTrack, source: Track.Source) {
    await this.room.localParticipant.publishTrack(track, {
      source,
      dtx: true,
      red: true,
      simulcast: source === Track.Source.Camera,
      videoCodec: 'h264',
    });
  }

  private async unpublish(track: MediaStreamTrack) {
    await this.room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
  }

  private onSubscribed(t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
    // Our own engine publishes as "{me}#screen": never pay for decoding it (PLAN 1.3).
    if (ownerOf(p.identity) === this.o.selfId) {
      pub.setSubscribed(false);
      return;
    }
    const kind = kindOf(p, t);
    const id = `${p.identity}:${t.sid}`;
    // A shared screen wants the lowest latency; cameras tolerate a little buffer (PLAN 7.5).
    if (t.receiver) t.receiver.jitterBufferTarget = kind === 'screen' ? 0 : kind === 'cam' ? 20 : t.receiver.jitterBufferTarget;
    const m: RemoteMedia = {
      id,
      userId: ownerOf(p.identity),
      kind,
      track: t.mediaStreamTrack,
      live: !t.isMuted,
      receiver: t.receiver,
      // attach() lets adaptiveStream pause video that is not visible.
      attach: (el) => void t.attach(el),
      detach: (el) => void t.detach(el),
    };
    this.remote.set(id, m);
    this.emit('track', m);
  }

  private onUnsubscribed(t: RemoteTrack, p: RemoteParticipant) {
    const id = `${p.identity}:${t.sid}`;
    if (this.remote.delete(id)) this.emit('trackEnded', id);
  }

  private onMuted(pub: { trackSid: string }, p: Participant, live: boolean) {
    const m = this.remote.get(`${p.identity}:${pub.trackSid}`);
    if (!m) return;
    m.live = live;
    this.emit('trackUpdate', m);
  }
}
