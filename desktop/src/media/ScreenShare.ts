// Screen sharing (PLAN 3.1 step 5, 6.5, 7.3): drives the native engine. The
// engine is warmed up on joining voice and stopped 60 s after leaving. In P2P
// the engine's offer/candidates go to the peer as rtc_signal (stream "screen",
// role "sender"); the viewer's answer/candidates (role "viewer") come back here.
// A voice_session change restarts the share on the new transport; an engine
// crash restarts the engine and the share.
import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { api } from '../api/rest';
import type { ContentMode, EncoderInfo, EngineEvent, EngineStats, MonitorInfo, Preset, SourceRef, WindowInfo } from '../shared/engine';
import type { RtcSignal } from '../shared/protocol';
import { engine, keepDisplayOn } from '../shared/shell';
import { useVoice } from '../stores/voice';
import { currentSession, onSessionReady, setViewerSignalHandler } from './call';
import { P2pSession } from './P2pSession';
import { SfuSession } from './SfuSession';

const ENGINE_IDLE_STOP_MS = 60_000;

export interface ShareParams {
  source: SourceRef;
  label: string;
  preset: Preset;
  content_mode: ContentMode;
  system_audio: boolean;
}

type Started = Extract<EngineEvent, { event: 'started' }>;

interface ScreenState {
  engineReady: boolean;
  encoders: EncoderInfo[];
  status: 'idle' | 'starting' | 'sharing' | 'restarting' | 'error';
  params: ShareParams | null;
  started: Started | null;
  stats: EngineStats | null;
  error: string | null;
  /** Time from a transport switch (or engine restart) to the share running again. */
  resumeMs: number | null;
  sources: { monitors: MonitorInfo[]; windows: WindowInfo[] } | null;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  start: (p: ShareParams) => Promise<void>;
  /** getDisplayMedia from the WebView, SFU only (engine missing or broken). */
  startFallback: () => Promise<void>;
  stop: () => void;
  update: (preset?: Preset, content?: ContentMode) => void;
}

let restartAt: number | null = null;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let engineRunning = false;
let peerForSession: { sessionId: string; peerId: string } | null = null;
let fallbackTrack: MediaStreamTrack | null = null;
// Set when the engine could not start or failed to initialise GStreamer.
let engineBroken = false;

async function ensureEngine() {
  clearTimeout(stopTimer);
  if (!engine.available || engineRunning) return;
  await engine.start();
  engineRunning = true;
  await engine.send({ cmd: 'probe' });
}

async function stunServer(): Promise<string | undefined> {
  const urls = (await api.iceServers().catch(() => null))?.ice_servers.flatMap((s) => [s.urls].flat()) ?? [];
  const stun = urls.find((u) => u.startsWith('stun:'));
  return stun ? stun.replace(/^stun:/, 'stun://') : undefined;
}

/** Engine target for the current voice transport. */
async function target() {
  const s = currentSession();
  const v = useVoice.getState().session;
  if (!s || !v || v.mode === 'idle') throw new Error('Entre numa chamada com mais alguém para compartilhar.');
  if (s instanceof SfuSession) return s.prepareScreen();
  if (s instanceof P2pSession) {
    peerForSession = { sessionId: v.session_id, peerId: v.peer_user_id! };
    return { kind: 'p2p' as const, session_id: v.session_id, stun_server: await stunServer() };
  }
  throw new Error('Sem transporte de mídia.');
}

export const useScreen = create<ScreenState>()((set, get) => ({
  engineReady: false,
  encoders: [],
  status: 'idle',
  params: null,
  started: null,
  stats: null,
  error: null,
  resumeMs: null,
  sources: null,
  pickerOpen: false,
  openPicker: () => {
    if (!engine.available || engineBroken) return void get().startFallback();
    set({ pickerOpen: true, sources: null });
    void ensureEngine()
      .then(() => engine.send({ cmd: 'list_sources', thumbnails: true }))
      .catch(() => {
        engineBroken = true;
        void get().startFallback();
      });
  },
  closePicker: () => set({ pickerOpen: false }),
  start: async (p) => {
    set({ pickerOpen: false, params: p, status: get().status === 'sharing' ? 'restarting' : 'starting', error: null });
    try {
      await ensureEngine();
      const t = await target();
      await engine.send({ cmd: 'start', target: t, source: p.source, preset: p.preset, content_mode: p.content_mode, system_audio: p.system_audio });
      void keepDisplayOn(true);
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
    }
  },
  startFallback: async () => {
    const s = currentSession();
    if (!(s instanceof SfuSession)) {
      set({ status: 'error', error: 'Sem o engine de captura, compartilhar só funciona com 3 ou mais pessoas (SFU).' });
      return;
    }
    set({ pickerOpen: false, status: 'starting', error: null });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, height: { ideal: 720 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      fallbackTrack = track;
      track.onended = () => useScreen.getState().stop();
      await s.publishScreen(track);
      const { width = 0, height = 0 } = track.getSettings();
      set({
        status: 'sharing',
        params: { source: { kind: 'monitor', id: '' }, label: track.label, preset: '720p30', content_mode: 'text', system_audio: false },
        started: { event: 'started', encoder: 'webview2', adapter: null, zero_copy: false, codec: 'h264', width, height, fps: 30 },
      });
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
    }
  },
  stop: () => {
    restartAt = null;
    peerForSession = null;
    if (fallbackTrack) {
      fallbackTrack.stop();
      fallbackTrack = null;
      const s = currentSession();
      if (s instanceof SfuSession) void s.publishScreen(null);
    }
    if (engineRunning) void engine.send({ cmd: 'stop' });
    void keepDisplayOn(false);
    set({ status: 'idle', params: null, started: null, stats: null });
  },
  update: (preset, content) => {
    const p = get().params;
    if (!p) return;
    set({ params: { ...p, preset: preset ?? p.preset, content_mode: content ?? p.content_mode } });
    void engine.send({ cmd: 'update', preset, content_mode: content });
  },
}));

function onEngineEvent(ev: EngineEvent) {
  const s = useScreen.getState();
  switch (ev.event) {
    case 'ready':
      useScreen.setState({ engineReady: true, encoders: ev.encoders });
      break;
    case 'sources':
      if (s.pickerOpen) useScreen.setState({ sources: { monitors: ev.monitors, windows: ev.windows } });
      break;
    case 'started':
      useScreen.setState({
        status: 'sharing',
        started: ev,
        resumeMs: restartAt ? Math.round(performance.now() - restartAt) : s.resumeMs,
      });
      restartAt = null;
      break;
    case 'stats':
      useScreen.setState({ stats: ev });
      break;
    case 'sdp':
    case 'ice': {
      if (!peerForSession || ev.session_id !== peerForSession.sessionId) return;
      const payload =
        ev.event === 'sdp'
          ? { role: 'sender', sdp: ev.sdp }
          : { role: 'sender', candidate: ev.candidate, sdpMid: ev.sdp_mid, sdpMLineIndex: ev.sdp_m_line_index };
      gateway.send({
        op: 'rtc_signal',
        d: { session_id: ev.session_id, to_user_id: peerForSession.peerId, stream: 'screen', type: ev.event === 'sdp' ? ev.type : 'ice', payload },
      });
      break;
    }
    case 'stopped':
      if (s.status === 'sharing' || s.status === 'starting') useScreen.setState({ status: 'idle', started: null, stats: null });
      break;
    case 'error':
      if (ev.code === 'gst_init') engineBroken = true;
      if (ev.fatal || ev.code === 'start_failed') useScreen.setState({ status: 'error', error: ev.message });
      break;
  }
}

/** Viewer answer/candidates for our engine's P2P session. */
function onViewerSignal(sig: RtcSignal) {
  if (!peerForSession || sig.session_id !== peerForSession.sessionId) return;
  const p = sig.payload as { sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number };
  if (sig.type === 'answer' && p.sdp) void engine.send({ cmd: 'sdp', session_id: sig.session_id, type: 'answer', sdp: p.sdp });
  else if (sig.type === 'ice' && p.candidate)
    void engine.send({ cmd: 'ice', session_id: sig.session_id, candidate: p.candidate, sdp_mid: p.sdpMid ?? null, sdp_m_line_index: p.sdpMLineIndex ?? 0 });
}

/** Restarts a running share on the current transport (after a voice_session switch). */
function retarget() {
  const { params, status } = useScreen.getState();
  if (!params || (status !== 'sharing' && status !== 'restarting' && status !== 'starting')) return;
  restartAt = performance.now();
  void useScreen.getState().start(params);
}

let started = false;
export function startScreenController() {
  if (started || !engine.available) return;
  started = true;
  setViewerSignalHandler(onViewerSignal);
  onSessionReady(retarget);
  void engine.onEvent(onEngineEvent);
  void engine.onExit(() => {
    engineRunning = false;
    useScreen.setState({ engineReady: false });
    const { params, status } = useScreen.getState();
    if (params && (status === 'sharing' || status === 'starting' || status === 'restarting')) {
      restartAt = performance.now();
      void useScreen.getState().start(params);
    }
  });
  useVoice.subscribe((v, prev) => {
    if (v.channelId && !prev.channelId) void ensureEngine().catch(() => {});
    if (!v.channelId && prev.channelId) {
      useScreen.getState().stop();
      stopTimer = setTimeout(() => {
        engineRunning = false;
        void engine.stop();
      }, ENGINE_IDLE_STOP_MS);
    }
  });
}
