// Tray icon and window behaviour (PLAN fase 9D). The icon follows the voice
// state: not in voice, in a call, speaking (green ring) or muted/deafened (red
// dot). Speaking comes from the media session (getStats at 10 Hz in P2P,
// ActiveSpeakersChanged in SFU), which keeps running with the window hidden.
import { appName, autostart, inTauri, tray, type TrayIconState } from '../shared/shell';
import { useCommunity } from '../stores/community';
import { useSettings } from '../stores/settings';
import { useSpeaking } from '../stores/speaking';
import { useVoice } from '../stores/voice';

// Speaking stays lit this long after the last loud sample, and the icon
// changes at most this often, so it does not flicker between words.
const SPEAKING_HOLD_MS = 300;
const MIN_GAP_MS = 150;

let name = 'DiscGo';
let speakingUntil = 0;
let lastKey = '';
let lastSentAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function current() {
  const v = useVoice.getState();
  const me = useCommunity.getState().me?.id;
  const now = performance.now();
  if (me && useSpeaking.getState().ids.has(me)) speakingUntil = now + SPEAKING_HOLD_MS;
  const speaking = now < speakingUntil;

  let state: TrayIconState = 'idle';
  let tooltip = name;
  if (v.channelId) {
    const channel = useCommunity.getState().channels.find((c) => c.id === v.channelId)?.name;
    state = v.selfDeaf || v.selfMute ? 'muted' : speaking ? 'speaking' : 'voice';
    const detail = v.selfDeaf ? 'Ensurdecido' : v.selfMute ? 'Mudo' : channel;
    if (detail) tooltip = `${name} · ${detail}`;
  }
  return { state, tooltip, mute: v.selfMute, deaf: v.selfDeaf, speaking };
}

function update() {
  clearTimeout(timer);
  const s = current();
  const key = `${s.state}|${s.tooltip}|${s.mute}|${s.deaf}`;
  const wait = lastSentAt + MIN_GAP_MS - performance.now();
  if (key !== lastKey) {
    if (wait > 0) {
      timer = setTimeout(update, wait);
      return;
    }
    lastKey = key;
    lastSentAt = performance.now();
    void tray.setState(s.state, s.tooltip, s.mute, s.deaf).catch(() => {});
  }
  // Re-check when the speaking hold runs out (nothing else would trigger it).
  if (s.speaking) timer = setTimeout(update, Math.max(speakingUntil - performance.now(), 0) + 1);
}

/** Keeps the "Iniciar com o Windows" entry in line with the setting (installed builds only). */
async function syncAutostart(on: boolean) {
  if (import.meta.env.DEV) return;
  try {
    if ((await autostart.isEnabled()) !== on) await autostart.set(on);
  } catch {
    /* registry not writable: the toggle simply has no effect */
  }
}

/** Call after the settings are loaded. */
export function startTray() {
  if (!inTauri) return;
  useVoice.subscribe(update);
  useSpeaking.subscribe(update);
  useCommunity.subscribe((s, prev) => {
    if (s.channels !== prev.channels || s.me !== prev.me) update();
  });
  update();
  void appName().then((n) => {
    name = n;
    update();
  });

  void tray.onToggle('mute', () => useVoice.getState().toggleMute());
  void tray.onToggle('deaf', () => useVoice.getState().toggleDeaf());

  const { closeToTray, startWithWindows } = useSettings.getState();
  void tray.setCloseToTray(closeToTray);
  void syncAutostart(startWithWindows);
  useSettings.subscribe((s, prev) => {
    if (s.closeToTray !== prev.closeToTray) void tray.setCloseToTray(s.closeToTray);
    if (s.startWithWindows !== prev.startWithWindows) void syncAutostart(s.startWithWindows);
  });
}
