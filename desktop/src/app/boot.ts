// Wires the gateway, deep links and stores together. Runs once at startup.
import { gateway } from '../api/gateway';
import { onRtcSignal, startCallController } from '../media/call';
import { startScreenController } from '../media/ScreenShare';
import { startTray } from './tray';
import { resumeAfterUpdate, startUpdateChecks, takeResume } from './updates';
import { play } from '../lib/sounds';
import type { ServerEvent } from '../shared/protocol';
import { appVersion, onDeepLink } from '../shared/shell';
import { useCommunity } from '../stores/community';
import { useFriends } from '../stores/friends';
import { useMessages } from '../stores/messages';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { useVoice } from '../stores/voice';

let booted = false;

export async function boot() {
  if (booted) return;
  booted = true;

  gateway.version = await appVersion().catch(() => 'unknown');
  startCallController();
  startScreenController();
  startUpdateChecks();
  gateway.onStatus((s) => useCommunity.getState().setStatus(s));
  gateway.on((ev) => {
    voiceSounds(ev);
    useCommunity.getState().apply(ev);
    useFriends.getState().apply(ev);
    useMessages.getState().apply(ev);
    useVoice.getState().apply(ev, useCommunity.getState().me?.id);
    if (ev.op === 'rtc_signal') onRtcSignal(ev.d);
  });

  await onDeepLink((url) => {
    // discgo://auth?code=… after the browser login.
    if (url.host === 'auth') {
      const code = url.searchParams.get('code');
      if (code) void useSession.getState().loginWithCode(code);
    }
  }).catch(() => {});

  await useSettings.getState().load();
  startTray();
  const resume = await takeResume();
  await useSession.getState().init();
  if (resume) resumeAfterUpdate(resume, useSession.getState().status === 'signed_in');

  // Dev only: `?dev_email=` logs in without Google (API with AUTH_DEV=true), for scripted checks.
  const devEmail = import.meta.env.DEV ? new URLSearchParams(location.search).get('dev_email') : null;
  if (devEmail && useSession.getState().status === 'signed_out') {
    await useSession.getState().devLogin(devEmail, devEmail.split('@')[0]);
  }
  if (import.meta.env.DEV) void import('../spike/callReport').then((m) => m.startDevCallTools());
}

/** Join/leave chimes when someone else enters or leaves our voice channel. */
function voiceSounds(ev: ServerEvent) {
  if (ev.op !== 'voice_state_update') return;
  const mine = useVoice.getState().channelId;
  const me = useCommunity.getState().me?.id;
  if (!mine || ev.d.user_id === me) return;
  const before = useCommunity.getState().voiceStates[ev.d.user_id]?.channel_id ?? null;
  if (before !== mine && ev.d.channel_id === mine) play('join');
  else if (before === mine && ev.d.channel_id !== mine) play('leave');
}
