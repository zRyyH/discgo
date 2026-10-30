// Dev-only call tooling for phase 5/6 checks, driven by URL params:
//   ?autojoin=<voice channel id>  join that channel once connected
//   ?report=1                     post call state to the spike harness every second
//   ?force_p2p_fail=1             (read by media/call.ts) make P2P fail, like a peer without UDP
//   ?cam=1 / ?mute=1              turn the camera on / mute once in the call
//   ?share=1[&preset=1440p60]     share the primary monitor once in the call (Tauri only)
//   ?view=friends / ?settings=app open that screen once connected (for screenshots)
import { useCall } from '../media/call';
import { useScreen } from '../media/ScreenShare';
import type { Preset } from '../shared/engine';
import { useCommunity } from '../stores/community';
import { useSpeaking } from '../stores/speaking';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';

const HARNESS = 'http://127.0.0.1:8090/report';

function shareOnce(preset: Preset) {
  useScreen.getState().openPicker();
  const unsub = useScreen.subscribe((s) => {
    const m = s.sources?.monitors.find((x) => x.primary) ?? s.sources?.monitors[0];
    if (!m) return;
    unsub();
    void s.start({ source: { kind: 'monitor', id: m.id }, label: m.name, preset, content_mode: 'text', system_audio: false });
  });
}

export function startDevCallTools() {
  const q = new URLSearchParams(location.search);
  // ?view=friends / ?settings=<section>: open a screen once connected (screenshots).
  const view = q.get('view');
  const section = q.get('settings');
  if (view || section) {
    const open = () => {
      if (!useCommunity.getState().ready) return;
      unsub();
      if (view === 'friends' || view === 'chat') useUi.getState().setView(view);
      if (section) useUi.getState().openSettings(section as Parameters<ReturnType<typeof useUi.getState>['openSettings']>[0]);
    };
    const unsub = useCommunity.subscribe(open);
    open();
  }
  const autojoin = q.get('autojoin');
  if (autojoin) {
    const tryJoin = () => {
      if (useCommunity.getState().ready && !useVoice.getState().channelId) {
        useVoice.getState().join(autojoin);
        useUi.getState().setView('call');
      }
    };
    useCommunity.subscribe(tryJoin);
    tryJoin();
  }
  let applied = false;
  useCall.subscribe((c) => {
    if (applied || c.state !== 'connected') return;
    applied = true;
    if (q.get('cam') === '1') void c.toggleCam();
    if (q.get('mute') === '1') useVoice.getState().toggleMute();
    if (q.get('share') === '1') shareOnce((q.get('preset') as Preset | null) ?? '1080p60');
  });
  if (q.get('report') === '1') {
    setInterval(() => {
      const c = useCall.getState();
      const sc = useScreen.getState();
      const me = useCommunity.getState().me;
      void fetch(HARNESS, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({
          check: 'call',
          user: me?.display_name,
          mode: c.mode,
          state: c.state,
          session: c.sessionId?.slice(-6),
          connect_ms: c.connectedAt && c.sessionAt ? Math.round(c.connectedAt - c.sessionAt) : null,
          rtt_ms: c.stats?.rttMs,
          jitter_ms: c.stats?.audioJitterMs,
          loss: c.stats?.audioLoss,
          out_kbps: c.stats?.outKbps,
          candidate: c.stats?.candidate,
          remote: c.remote.map((r) => `${useCommunity.getState().members[r.userId]?.display_name ?? r.userId.slice(-4)}:${r.kind}${r.live ? '' : '(off)'}`),
          speaking: [...useSpeaking.getState().ids].map((id) => useCommunity.getState().members[id]?.display_name),
          mute: useVoice.getState().selfMute,
          cam: c.camOn,
          error: c.error,
          screen: sc.status,
          screen_fps: sc.stats?.fps_encoded,
          screen_kbps: sc.stats?.bitrate_kbps,
          zero_copy: sc.started?.zero_copy,
          screen_resume_ms: sc.resumeMs,
          screen_error: sc.error,
        }),
      });
    }, 1000);
  }
}
