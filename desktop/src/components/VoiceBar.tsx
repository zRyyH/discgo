import { HeadphoneOff, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useCall } from '../media/call';
import { useCommunity } from '../stores/community';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { IconButton, cx } from './ui';

/** Floating call controls at the bottom of the center pane (PLAN 8). */
export function VoiceBar({ onShare, sharing }: { onShare?: () => void; sharing?: boolean }) {
  const { channelId, selfMute, selfDeaf, toggleMute, toggleDeaf, leave } = useVoice(
    useShallow((s) => ({
      channelId: s.channelId,
      selfMute: s.selfMute,
      selfDeaf: s.selfDeaf,
      toggleMute: s.toggleMute,
      toggleDeaf: s.toggleDeaf,
      leave: s.leave,
    })),
  );
  const channel = useCommunity((s) => s.channels.find((c) => c.id === channelId));
  const { mode, state, rtt, camOn, toggleCam, error } = useCall(
    useShallow((s) => ({ mode: s.mode, state: s.state, rtt: s.stats?.rttMs, camOn: s.camOn, toggleCam: s.toggleCam, error: s.error })),
  );
  const setView = useUi((s) => s.setView);
  if (!channelId) return null;

  const status =
    mode === 'idle'
      ? 'Sozinho no canal'
      : state === 'connected'
        ? `${mode === 'p2p' ? 'P2P' : 'SFU'}${rtt != null ? ` · ${rtt} ms` : ''}`
        : state === 'reconnecting'
          ? 'Reconectando…'
          : state === 'failed'
            ? 'Falha na conexão'
            : 'Conectando…';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-bg-1 px-2 py-1.5 shadow-popover">
        <button type="button" onClick={() => setView('call')} className="mr-2 min-w-0 px-1 text-left">
          <div className="max-w-44 truncate text-body font-semibold">{channel?.name ?? 'Voz'}</div>
          <div className={cx('text-meta', state === 'connected' || mode === 'idle' ? 'text-ok' : 'text-warn')} title={error ?? undefined}>
            {status}
          </div>
        </button>
        <IconButton icon={selfMute ? MicOff : Mic} label={selfMute ? 'Ativar microfone' : 'Silenciar'} danger={selfMute} onClick={toggleMute} />
        <IconButton icon={selfDeaf ? HeadphoneOff : Headphones} label={selfDeaf ? 'Ativar áudio' : 'Ensurdecer'} danger={selfDeaf} onClick={toggleDeaf} />
        <IconButton icon={camOn ? Video : VideoOff} label={camOn ? 'Desligar câmera' : 'Ligar câmera'} active={camOn} onClick={() => void toggleCam()} />
        <IconButton
          icon={MonitorUp}
          label={sharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
          active={sharing}
          disabled={!onShare || mode === 'idle'}
          onClick={onShare}
        />
        <div className="mx-1 h-6 w-px bg-border" />
        <IconButton icon={PhoneOff} label="Sair da chamada" danger onClick={leave} />
      </div>
    </div>
  );
}
