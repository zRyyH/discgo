// Viewer side of a P2P screen share (PLAN 3.1 step 5): a receive-only
// RTCPeerConnection that answers the sharer's engine (webrtcsink) offer.
import type { RtcSignal } from '../shared/protocol';
import type { RemoteMedia } from './MediaSession';

export class ScreenReceiver {
  private pc: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private ids: string[] = [];

  constructor(
    private sessionId: string,
    private peerId: string,
    iceServers: RTCIceServer[],
    private onTrack: (m: RemoteMedia) => void,
    private onEnded: (id: string) => void,
    private send: (sig: Omit<RtcSignal, 'from_user_id'>) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        const c = e.candidate.toJSON();
        this.signal('ice', { role: 'viewer', candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
      }
    };
    this.pc.ontrack = (e) => {
      const kind = e.track.kind === 'video' ? 'screen' : 'screen_audio';
      // Screens want the lowest latency (PLAN 7.5).
      e.receiver.jitterBufferTarget = 0;
      const id = `${this.peerId}:p2p-${kind}`;
      this.ids.push(id);
      this.onTrack({
        id,
        userId: this.peerId,
        kind,
        track: e.track,
        live: true,
        receiver: e.receiver,
        attach: (el) => void (el.srcObject = new MediaStream([e.track])),
        detach: (el) => void (el.srcObject = null),
      });
      e.track.onended = () => this.onEnded(id);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.dropTracks();
    };
  }

  async handle(sig: RtcSignal) {
    const p = sig.payload as { sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    try {
      // One offer per receiver: a sharer that restarts sends a new offer to a new receiver.
      if (sig.type === 'offer' && p.sdp && !this.pc.remoteDescription) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal('answer', { role: 'viewer', sdp: answer.sdp });
      } else if (sig.type === 'ice' && p.candidate) {
        const c = { candidate: p.candidate, sdpMid: p.sdpMid ?? undefined, sdpMLineIndex: p.sdpMLineIndex ?? 0 };
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {});
        else this.pending.push(c);
      }
    } catch (e) {
      console.warn('screen receiver', e);
    }
  }

  close() {
    this.dropTracks();
    this.pc.close();
  }

  private dropTracks() {
    for (const id of this.ids.splice(0)) this.onEnded(id);
  }

  private signal(type: RtcSignal['type'], payload: unknown) {
    this.send({ session_id: this.sessionId, to_user_id: this.peerId, stream: 'screen', type, payload });
  }
}
