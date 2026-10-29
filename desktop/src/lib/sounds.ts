// Short UI sounds (PLAN 8): local .ogg files at 30 % volume, can be turned off.
import join from '../assets/sounds/join.ogg';
import leave from '../assets/sounds/leave.ogg';
import mute from '../assets/sounds/mute.ogg';
import unmute from '../assets/sounds/unmute.ogg';
import stream from '../assets/sounds/stream.ogg';
import { useSettings } from '../stores/settings';

const files = { join, leave, mute, unmute, stream };
export type Sound = keyof typeof files;

const cache = new Map<Sound, HTMLAudioElement>();

export function play(sound: Sound) {
  if (!useSettings.getState().sounds) return;
  let el = cache.get(sound);
  if (!el) {
    el = new Audio(files[sound]);
    el.volume = 0.3;
    cache.set(sound, el);
  }
  el.currentTime = 0;
  void el.play().catch(() => {});
}
