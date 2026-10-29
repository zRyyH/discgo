// Remote audio playback (PLAN 7.4): one hidden <audio> per remote audio track,
// per-user volume, deafen = mute every element, output device via setSinkId.
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

interface Entry {
  el: SinkAudio;
  userId: string;
}

const entries = new Map<string, Entry>();
let deafened = false;
let sinkId = 'default';
let volumes: Record<string, number> = {};

function applyVolume(e: Entry) {
  e.el.muted = deafened;
  e.el.volume = Math.max(0, Math.min(1, volumes[e.userId] ?? 1));
}

export const audioOut = {
  add(id: string, userId: string, track: MediaStreamTrack) {
    audioOut.remove(id);
    const el = document.createElement('audio') as SinkAudio;
    el.autoplay = true;
    el.srcObject = new MediaStream([track]);
    const e = { el, userId };
    entries.set(id, e);
    applyVolume(e);
    if (sinkId !== 'default') void el.setSinkId?.(sinkId).catch(() => {});
    void el.play().catch(() => {});
  },
  remove(id: string) {
    const e = entries.get(id);
    if (!e) return;
    e.el.pause();
    e.el.srcObject = null;
    entries.delete(id);
  },
  clear() {
    for (const id of [...entries.keys()]) audioOut.remove(id);
  },
  setDeafened(on: boolean) {
    deafened = on;
    entries.forEach(applyVolume);
  },
  setVolumes(v: Record<string, number>) {
    volumes = v;
    entries.forEach(applyVolume);
  },
  setSink(id: string) {
    sinkId = id || 'default';
    entries.forEach((e) => void e.el.setSinkId?.(sinkId).catch(() => {}));
  },
};
