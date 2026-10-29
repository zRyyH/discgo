// Direct call with the single other participant (PLAN 2.2, 7.4): one
// RTCPeerConnection carrying mic + camera, "perfect negotiation" (the polite
// peer is the smaller user id), signalling relayed by the gateway as rtc_signal.
// Failure (ICE failed, disconnected > 5 s, or not connected within 8 s) is
// reported so the server can move the channel to the SFU.
import type { EngineTarget } from '../shared/engine';
import type { RtcSignal } from '../shared/protocol';
import { Emitter, type MediaSession, type RemoteMedia, type SessionStats } from './MediaSession';

const CONNECT_TIMEOUT_MS = 8000;
const DISCONNECTED_GRACE_MS = 5000;
const SPEAKING_LEVEL = 0.03;
const SPEAKING_HOLD_MS = 350;
const CAM_MAX_BITRATE = 1_500_000;

export interface P2pOptions {
  sessionId: string;
  selfId: string;
  peerId: string;
  polite: boolean;
  iceServers: RTCIceServer[];
  /** Opus target, kbit/s (64, or 96 in high quality). */
  voiceKbps: number;
  /** Dev: force ICE to fail (simulates a peer without UDP). */
  forceFail?: boolean;
  send: (sig: Omit<RtcSignal, 'from_user_id'>) => void;
  onFailed: (reason: string) => void;
}

/** Sets the Opus fmtp parameters of PLAN 7.4 on an SDP. */
export function mungeOpus(sdp: string, kbps: number): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1];
  if (!pt) return sdp;
  const params = `minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${kbps * 1000}`;
  const fmtp = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
  sdp = fmtp.test(sdp) ? sdp.replace(fmtp, `a=fmtp:${pt} ${params}`) : sdp.replace(`a=rtpmap:${pt} opus/48000/2`, `a=rtpmap:${pt} opus/48000/2\r\na=fmtp:${pt} ${params}`);
  return sdp.includes('a=ptime:') ? sdp : sdp.replace(/(m=audio[^\r\n]*\r\n)/, '$1a=ptime:20\r\n');
}

function preferCodecs(t: RTCRtpTransceiver, kind: 'audio' | 'video') {
  const caps = RTCRtpReceiver.getCapabilities(kind)?.codecs;
  if (!caps || !t.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec) => {
    const m = c.mimeType.toLowerCase();
    if (kind === 'audio') return m === 'audio/red' ? 0 : m === 'audio/opus' ? 1 : 2;
    return m === 'video/h264' ? 0 : m === 'video/vp8' ? 1 : 2;
  };
  try {
    t.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch {
    /* keep the browser default */
  }
}

export class P2pSession extends Emitter implements MediaSession {
  readonly mode = 'p2p' as const;
  private pc: RTCPeerConnection;
  private audioT: RTCRtpTransceiver | null = null;
  private videoT: RTCRtpTransceiver | null = null;
  private mic: MediaStreamTrack | null = null;
  private cam: MediaStreamTrack | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private lastLoud: Record<string, number> = {};
  private remote = new Map<string, RemoteMedia>();
  private closed = false;
  private failed = false;
  private prevBytes = { out: 0, in: 0, at: 0 };

  constructor(private o: P2pOptions) {
    super();
    this.pc = new RTCPeerConnection({
      iceServers: o.iceServers,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: o.forceFail ? 'relay' : 'all',
    });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signal('ice', e.candidate.toJSON());
    };
    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.ontrack = (e) => this.onTrack(e);
    this.pc.oniceconnectionstatechange = () => this.onIceState();
  }

  async connect() {
    this.emit('state', 'connecting');
    this.connectTimer = setTimeout(() => this.fail('timeout'), CONNECT_TIMEOUT_MS);
    // The impolite peer creates the transceivers and makes the first offer; the polite
    // peer adopts them from that offer, so both sides share one audio and one video m-line.
    if (!this.o.polite) {
      this.audioT = this.pc.addTransceiver(this.mic ?? 'audio', { direction: 'sendrecv' });
      this.videoT = this.pc.addTransceiver(this.cam ?? 'video', { direction: this.cam ? 'sendrecv' : 'recvonly' });
      preferCodecs(this.audioT, 'audio');
      preferCodecs(this.videoT, 'video');
    }
    this.levelTimer = setInterval(() => void this.pollLevels(), 100);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.levelTimer);
    for (const id of this.remote.keys()) this.emit('trackEnded', id);
    this.remote.clear();
    this.pc.close();
    this.emit('state', 'closed');
  }

  async setMic(track: MediaStreamTrack | null) {
    this.mic = track;
    if (this.audioT) await this.audioT.sender.replaceTrack(track);
  }

  async setCamera(track: MediaStreamTrack | null) {
    this.cam = track;
    if (!this.videoT) return;
    await this.videoT.sender.replaceTrack(track);
    // Direction change renegotiates, so the peer sees the camera go away (track muted).
    this.videoT.direction = track ? 'sendrecv' : 'recvonly';
    if (track) void this.capCamera();
  }

  screenTarget(): EngineTarget {
    return { kind: 'p2p', session_id: this.o.sessionId };
  }

  /** Incoming rtc_signal for the "av" stream. */
  async receive(sig: RtcSignal) {
    if (this.closed) return;
    const payload = sig.payload as { sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    try {
      if (sig.type === 'ice') {
        if (!this.pc.remoteDescription) this.pendingIce.push(payload as RTCIceCandidateInit);
        else await this.addIce(payload as RTCIceCandidateInit);
        return;
      }
      const desc = { type: sig.type, sdp: payload.sdp } as RTCSessionDescriptionInit;
      const collision = desc.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.o.polite && collision;
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(desc); // rolls back our own offer on collision (polite)
      for (const c of this.pendingIce.splice(0)) await this.addIce(c);
      if (desc.type === 'offer') {
        this.adoptTransceivers();
        const answer = await this.pc.createAnswer();
        answer.sdp = mungeOpus(answer.sdp!, this.o.voiceKbps);
        await this.pc.setLocalDescription(answer);
        this.signal('answer', { sdp: answer.sdp });
      }
    } catch (e) {
      console.warn('p2p signal', e);
    }
  }

  async stats(): Promise<SessionStats> {
    const out: SessionStats = { rttMs: null, audioJitterMs: null, audioLoss: null, outKbps: null, inKbps: null, candidate: null };
    if (this.closed) return out;
    const report = await this.pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (pair) {
      out.rttMs = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const local = report.get(pair.localCandidateId) as { candidateType?: string; protocol?: string } | undefined;
      const remote = report.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
      out.candidate = `${local?.candidateType ?? '?'}/${local?.protocol ?? '?'} ↔ ${remote?.candidateType ?? '?'}`;
      const now = performance.now();
      const bOut = pair.bytesSent ?? 0;
      const bIn = pair.bytesReceived ?? 0;
      if (this.prevBytes.at) {
        const dt = (now - this.prevBytes.at) / 1000;
        out.outKbps = Math.round(((bOut - this.prevBytes.out) * 8) / dt / 1000);
        out.inKbps = Math.round(((bIn - this.prevBytes.in) * 8) / dt / 1000);
      }
      this.prevBytes = { out: bOut, in: bIn, at: now };
    }
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.jitterBufferEmittedCount) {
        out.audioJitterMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
        const total = (s.packetsReceived ?? 0) + (s.packetsLost ?? 0);
        out.audioLoss = total ? +((s.packetsLost ?? 0) / total).toFixed(3) : 0;
      }
    });
    return out;
  }

  private async negotiate() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      if (this.pc.signalingState !== 'stable') return;
      offer.sdp = mungeOpus(offer.sdp!, this.o.voiceKbps);
      await this.pc.setLocalDescription(offer);
      this.signal('offer', { sdp: offer.sdp });
    } catch (e) {
      console.warn('p2p negotiate', e);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Polite side: take over the transceivers the offer created and attach our tracks. */
  private adoptTransceivers() {
    for (const t of this.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' && !this.audioT) {
        this.audioT = t;
        t.direction = 'sendrecv';
        preferCodecs(t, 'audio');
        void t.sender.replaceTrack(this.mic);
      } else if (kind === 'video' && !this.videoT) {
        this.videoT = t;
        t.direction = this.cam ? 'sendrecv' : 'recvonly';
        preferCodecs(t, 'video');
        void t.sender.replaceTrack(this.cam);
      }
    }
  }

  private async addIce(c: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(c);
    } catch (e) {
      if (!this.ignoreOffer) console.warn('p2p ice', e);
    }
  }

  private onTrack(e: RTCTrackEvent) {
    const kind = e.track.kind === 'audio' ? 'mic' : 'cam';
    const id = `${this.o.peerId}:${kind}`;
    if (kind === 'cam') e.receiver.jitterBufferTarget = 20;
    const m: RemoteMedia = {
      id,
      userId: this.o.peerId,
      kind,
      track: e.track,
      live: !e.track.muted,
      receiver: e.receiver,
      attach: (el) => {
        el.srcObject = new MediaStream([e.track]);
      },
      detach: (el) => {
        el.srcObject = null;
      },
    };
    this.remote.set(id, m);
    e.track.onmute = () => this.setLive(id, false);
    e.track.onunmute = () => this.setLive(id, true);
    this.emit('track', m);
  }

  private setLive(id: string, live: boolean) {
    const m = this.remote.get(id);
    if (!m || m.live === live) return;
    m.live = live;
    this.emit('trackUpdate', m);
  }

  private onIceState() {
    const s = this.pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      clearTimeout(this.connectTimer);
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
      this.emit('state', 'connected');
      if (this.cam) void this.capCamera();
    } else if (s === 'disconnected') {
      this.emit('state', 'reconnecting');
      this.disconnectTimer ??= setTimeout(() => this.fail('disconnected'), DISCONNECTED_GRACE_MS);
    } else if (s === 'failed') {
      this.fail('ice failed');
    }
  }

  private fail(reason: string) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.emit('state', 'failed');
    this.o.onFailed(reason);
  }

  private async capCamera() {
    const sender = this.videoT?.sender;
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = CAM_MAX_BITRATE;
    await sender.setParameters(p).catch(() => {});
  }

  /** Speaking indicator from audioLevel at 10 Hz (PLAN 7.4). */
  private async pollLevels() {
    if (this.closed) return;
    const report = await this.pc.getStats().catch(() => null);
    if (!report) return;
    const now = performance.now();
    report.forEach((s) => {
      if (s.type === 'media-source' && s.kind === 'audio' && (s.audioLevel ?? 0) > SPEAKING_LEVEL && this.mic?.enabled) {
        this.lastLoud[this.o.selfId] = now;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio' && (s.audioLevel ?? 0) > SPEAKING_LEVEL) {
        this.lastLoud[this.o.peerId] = now;
      }
    });
    this.emit(
      'speaking',
      Object.entries(this.lastLoud)
        .filter(([, t]) => now - t < SPEAKING_HOLD_MS)
        .map(([id]) => id),
    );
  }

  private signal(type: RtcSignal['type'], payload: unknown) {
    this.o.send({ session_id: this.o.sessionId, to_user_id: this.o.peerId, stream: 'av', type, payload });
  }
}
