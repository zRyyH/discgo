// Forced updates (PLAN fase 9A). The gateway's `app_update`, the check at start
// and the one every 6 h all run the same flow, with no click: download with
// progress, a 3 s countdown, then the silent installer restarts the app, which
// goes back to the same voice channel (see `resumeAfterUpdate`). Packages are
// verified against the minisign key in tauri.conf.json; the server event is
// only a trigger. The titlebar button is the fallback when something fails.
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { appVersion, engine, inTauri, settings } from '../shared/shell';
import { useScreen } from '../media/ScreenShare';
import { toast } from '../stores/toast';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
// The server can see a new latest.json before the updater does (caches).
const SERVER_RETRY_MS = 30_000;
const SERVER_RETRIES = 10;
const COUNTDOWN_S = 3;
const ENGINE_EXIT_WAIT_MS = 3_500;
const RESUME_KEY = 'resume';
const RESUME_WINDOW_MS = 3 * 60 * 1000;

const enabled = inTauri && !import.meta.env.DEV;

type Phase = 'idle' | 'downloading' | 'restarting' | 'failed';

interface UpdateState {
  phase: Phase;
  version: string | null;
  /** 0–100, null while the size is unknown. */
  percent: number | null;
  countdown: number;
  error: string | null;
  retry: () => void;
}

export const useUpdate = create<UpdateState>()(() => ({
  phase: 'idle',
  version: null,
  percent: null,
  countdown: COUNTDOWN_S,
  error: null,
  retry: () => void run(),
}));

const set = useUpdate.setState;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Checks and, when there is a newer version, installs it. Resolves to whether one was found. */
async function run(): Promise<boolean> {
  if (!enabled || running) return false;
  running = true;
  clearTimeout(retryTimer);
  try {
    // Offline, or no release published yet: nothing to show.
    const u = await check().catch(() => null);
    if (!u) return false;
    set({ phase: 'downloading', version: u.version, percent: 0, error: null });
    let total = 0;
    let got = 0;
    await u.download((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        const percent = total ? Math.min(100, Math.floor((got * 100) / total)) : null;
        if (percent !== useUpdate.getState().percent) set({ percent });
      }
    });
    for (let s = COUNTDOWN_S; s > 0; s--) {
      set({ phase: 'restarting', countdown: s });
      await sleep(1000);
    }
    await prepareRestart();
    await u.install(); // on Windows the installer takes over and this process exits
    await relaunch();
    return true;
  } catch (e) {
    set({ phase: 'failed', error: String(e) });
    retryTimer = setTimeout(() => void run(), RETRY_AFTER_FAILURE_MS);
    return true;
  } finally {
    running = false;
  }
}

async function serverSaysUpdate() {
  for (let i = 0; i < SERVER_RETRIES; i++) {
    if (running || useUpdate.getState().phase !== 'idle') return;
    if (await run()) return;
    await sleep(SERVER_RETRY_MS);
  }
}

export function startUpdateChecks() {
  if (!enabled) return;
  gateway.on((ev) => {
    if (ev.op === 'app_update') void serverSaysUpdate();
  });
  void run();
  setInterval(() => void run(), CHECK_EVERY_MS);
}

// --- coming back after the restart ---

interface Resume {
  channelId: string | null;
  view: ReturnType<typeof useUi.getState>['view'];
  selfMute: boolean;
  selfDeaf: boolean;
  at: number;
}

/** Saves where the user is, then releases the engine so the installer can replace it. */
async function prepareRestart() {
  const { channelId, selfMute, selfDeaf } = useVoice.getState();
  const resume: Resume = { channelId, view: useUi.getState().view, selfMute, selfDeaf, at: Date.now() };
  await settings.set(RESUME_KEY, resume);
  await settings.flush();

  // A screen share would restart the engine when it exits; end it first.
  useScreen.getState().stop();
  let exited: () => void = () => {};
  const gone = new Promise<void>((r) => (exited = r));
  const unlisten = await engine.onExit(() => exited());
  if (await engine.stop().catch(() => false)) await Promise.race([gone, sleep(ENGINE_EXIT_WAIT_MS)]);
  unlisten();
}

/** Reads (and forgets) what `prepareRestart` saved, if it is recent. */
export async function takeResume(): Promise<Resume | null> {
  const r = await settings.get<Resume | null>(RESUME_KEY).catch(() => null);
  if (!r) return null;
  await settings.set(RESUME_KEY, null).catch(() => {});
  return Date.now() - r.at < RESUME_WINDOW_MS ? r : null;
}

/**
 * After an update restart: puts the user back in the voice channel and view
 * they were in. Call it right after the session starts the gateway (before its
 * ready), so the voice store rejoins on ready like after a reconnect.
 */
export function resumeAfterUpdate(r: Resume, signedIn: boolean) {
  if (signedIn) {
    if (r.channelId) useVoice.setState({ channelId: r.channelId, selfMute: r.selfMute, selfDeaf: r.selfDeaf });
    if (r.view !== 'call' || r.channelId) useUi.getState().setView(r.view);
  }
  void appVersion().then((v) => toast(`Atualizado para a versão ${v}`, 'ok'));
}
