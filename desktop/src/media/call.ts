// Call controller (PLAN 3.1 steps 4 and 6, 7.3): follows voice_session from the
// server, tears the current MediaSession down and brings the new one up with the
// same mic/camera, mute and deafen state. Remote tracks are exposed to the UI.
import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { api } from '../api/rest';
import type { RtcSignal, VoiceSession } from '../shared/protocol';
import { useCommunity } from '../stores/community';
import { useSettings } from '../stores/settings';
import { useSpeaking } from '../stores/speaking';
import { useVoice } from '../stores/voice';
import { audioOut } from './audioOut';
import { openCamera, openMic } from './devices';
import type { MediaSession, RemoteMedia, SessionState, SessionStats } from './MediaSession';
import { P2pSession } from './P2pSession';
import { ScreenReceiver } from './ScreenReceiver';
import { play } from '../lib/sounds';
import { SfuSession } from './SfuSession';

interface CallState {
  state: SessionState | 'idle';
  mode: VoiceSession['mode'] | null;
  sessionId: string | null;
  remote: RemoteMedia[];
  camOn: boolean;
  localCam: MediaStreamTrack | null;
  error: string | null;
  /** When the current voice_session arrived and when its media connected (for the overlay). */
  sessionAt: number | null;
  connectedAt: number | null;
  stats: SessionStats | null;
  toggleCam: () => Promise<void>;
}

const dev = import.meta.env.DEV ? new URLSearchParams(location.search) : null;

let current: MediaSession | null = null;
let generation = 0;
let mic: MediaStreamTrack | null = null;
let cam: MediaStreamTrack | null = null;
let iceServers: RTCIceServer[] | null = null;
// rtc_signal can arrive before our P2pSession exists (the peer got voice_session first).
let earlySignals: RtcSignal[] = [];
let statsTimer: ReturnType<typeof setInterval> | undefined;
// P2P screen shares we are watching, by sharer.
const receivers = new Map<string, ScreenReceiver>();
const readyHooks = new Set<() => void>();
let viewerSignals: ((sig: RtcSignal) => void) | null = null;

/** ScreenShare.ts receives the viewer side of our own P2P share through this. */
export function setViewerSignalHandler(cb: (sig: RtcSignal) => void) {
  viewerSignals = cb;
}

/** Called every time a new session finished connecting (screen share re-targets on it). */
export function onSessionReady(cb: () => void): () => void {
  readyHooks.add(cb);
  return () => readyHooks.delete(cb);
}

function addRemote(m: RemoteMedia) {
  if (m.kind === 'mic' || m.kind === 'screen_audio') audioOut.add(m.id, m.userId, m.track);
  if (m.kind === 'screen') play('stream');
  useCall.setState((st) => ({ remote: [...st.remote.filter((r) => r.id !== m.id), m] }));
}

function removeRemote(id: string) {
  audioOut.remove(id);
  useCall.setState((st) => ({ remote: st.remote.filter((r) => r.id !== id) }));
}

export const useCall = create<CallState>()((set, get) => ({
  state: 'idle',
  mode: null,
  sessionId: null,
  remote: [],
  camOn: false,
  localCam: null,
  error: null,
  sessionAt: null,
  connectedAt: null,
  stats: null,
  toggleCam: async () => {
    if (get().camOn) {
      cam?.stop();
      cam = null;
      set({ camOn: false, localCam: null });
      await current?.setCamera(null);
      return;
    }
    try {
      cam = await openCamera(useSettings.getState().videoDeviceId);
      set({ camOn: true, localCam: cam, error: null });
      await current?.setCamera(cam);
    } catch (e) {
      set({ error: 'Não foi possível abrir a câmera: ' + (e as Error).message });
    }
  },
}));

function micEnabled() {
  const { selfMute, selfDeaf } = useVoice.getState();
  return !selfMute && !selfDeaf;
}

async function ensureMic(): Promise<MediaStreamTrack | null> {
  if (mic && mic.readyState === 'live') return mic;
  try {
    mic = await openMic(useSettings.getState().inputDeviceId);
    mic.enabled = micEnabled();
    useCall.setState({ error: null });
    return mic;
  } catch (e) {
    useCall.setState({ error: 'Microfone indisponível: ' + (e as Error).message });
    return null;
  }
}

function releaseDevices() {
  mic?.stop();
  mic = null;
  cam?.stop();
  cam = null;
  useCall.setState({ camOn: false, localCam: null });
}

async function teardown() {
  const s = current;
  current = null;
  clearInterval(statsTimer);
  receivers.forEach((r) => r.close());
  receivers.clear();
  audioOut.clear();
  useSpeaking.getState().set([]);
  useCall.setState({ remote: [], stats: null, connectedAt: null });
  await s?.close().catch(() => {});
}

async function switchTo(session: VoiceSession | null) {
  const gen = ++generation;
  earlySignals = earlySignals.filter((s) => s.session_id === session?.session_id);
  await teardown();
  if (!session) {
    releaseDevices();
    useCall.setState({ state: 'idle', mode: null, sessionId: null, sessionAt: null });
    return;
  }
  useCall.setState({ mode: session.mode, sessionId: session.session_id, sessionAt: performance.now(), state: session.mode === 'idle' ? 'idle' : 'connecting' });
  if (session.mode === 'idle') return; // alone in the channel: connect to nothing (PLAN 3.2)

  const track = await ensureMic();
  const voiceKbps = useSettings.getState().highQualityVoice ? 96 : 64;
  let s: MediaSession;
  try {
    if (session.mode === 'p2p') {
      iceServers ??= (await api.iceServers()).ice_servers;
      s = new P2pSession({
        sessionId: session.session_id,
        selfId: useCommunity.getState().me!.id,
        peerId: session.peer_user_id!,
        polite: !!session.polite,
        iceServers,
        voiceKbps,
        forceFail: dev?.get('force_p2p_fail') === '1',
        send: (sig) => gateway.send({ op: 'rtc_signal', d: sig }),
        onFailed: (reason) => gateway.send({ op: 'p2p_failed', d: { session_id: session.session_id, reason } }),
      });
    } else {
      const channelId = session.channel_id;
      const { token } = await api.voiceToken(channelId);
      s = new SfuSession({
        selfId: useCommunity.getState().me!.id,
        url: session.livekit_url!,
        token,
        voiceKbps,
        screenToken: () => api.voiceToken(channelId, 'screen').then((r) => r.token),
      });
    }
  } catch (e) {
    useCall.setState({ state: 'failed', error: 'Não foi possível entrar na chamada: ' + (e as Error).message });
    return;
  }
  if (gen !== generation) return void s.close();
  current = s;
  wire(s as P2pSession | SfuSession);
  await s.setMic(track);
  await s.setCamera(cam);
  try {
    await s.connect();
  } catch (e) {
    if (gen === generation) useCall.setState({ state: 'failed', error: (e as Error).message });
    return;
  }
  if (s instanceof P2pSession) for (const sig of earlySignals.splice(0)) void s.receive(sig);
  readyHooks.forEach((cb) => cb());
  statsTimer = setInterval(async () => {
    if (current === s) useCall.setState({ stats: await s.stats().catch(() => null) });
  }, 1000);
}

function wire(s: P2pSession | SfuSession) {
  const mine = () => current === s;
  s.on('track', (m) => mine() && addRemote(m));
  s.on('trackUpdate', (m) => mine() && useCall.setState((st) => ({ remote: st.remote.map((r) => (r.id === m.id ? { ...m } : r)) })));
  s.on('trackEnded', (id) => (mine() ? removeRemote(id) : audioOut.remove(id)));
  s.on('speaking', (ids) => mine() && useSpeaking.getState().set(ids));
  s.on('state', (state) => {
    if (!mine()) return;
    useCall.setState((st) => ({ state, connectedAt: state === 'connected' && !st.connectedAt ? performance.now() : st.connectedAt }));
  });
}

/** rtc_signal for the call itself ("av") or for a peer's screen we watch (role "sender"). */
export function onRtcSignal(sig: RtcSignal) {
  if (sig.stream === 'screen') {
    // Our own share's viewer answering, or a peer's share offering to us.
    if ((sig.payload as { role?: string })?.role === 'viewer') viewerSignals?.(sig);
    else onSenderSignal(sig);
    return;
  }
  if (current instanceof P2pSession && useCall.getState().sessionId === sig.session_id) void current.receive(sig);
  else if (sig.session_id === useVoice.getState().session?.session_id) earlySignals.push(sig);
}

export function currentSession(): MediaSession | null {
  return current;
}

let started = false;
export function startCallController() {
  if (started) return;
  started = true;
  useVoice.subscribe((v, prev) => {
    if (v.session?.session_id !== prev.session?.session_id || (!v.channelId && prev.channelId)) {
      void switchTo(v.channelId ? v.session : null);
    }
    if (v.selfMute !== prev.selfMute || v.selfDeaf !== prev.selfDeaf) {
      if (mic) mic.enabled = micEnabled();
      audioOut.setDeafened(v.selfDeaf);
    }
  });
  useSettings.subscribe((s, prev) => {
    if (s.userVolumes !== prev.userVolumes) audioOut.setVolumes(s.userVolumes);
    if (s.outputDeviceId !== prev.outputDeviceId) audioOut.setSink(s.outputDeviceId);
    if (s.inputDeviceId !== prev.inputDeviceId && mic) {
      mic.stop();
      mic = null;
      void ensureMic().then((t) => current?.setMic(t));
    }
  });
  const s = useSettings.getState();
  audioOut.setVolumes(s.userVolumes);
  audioOut.setSink(s.outputDeviceId);
}

function onSenderSignal(sig: RtcSignal) {
  const from = sig.from_user_id;
  if (!from || !(current instanceof P2pSession) || useCall.getState().sessionId !== sig.session_id) return;
  if (sig.type === 'offer') {
    receivers.get(from)?.close();
    const r = new ScreenReceiver(sig.session_id, from, iceServers ?? [], addRemote, removeRemote, (d) =>
      gateway.send({ op: 'rtc_signal', d }),
    );
    receivers.set(from, r);
  }
  void receivers.get(from)?.handle(sig);
}
