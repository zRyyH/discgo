import { memo, useMemo } from 'react';
import { Hash, Headphones, HeadphoneOff, Mic, MicOff, Plus, Settings, Users, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Channel } from '../shared/protocol';
import { useCommunity } from '../stores/community';
import { useIncomingCount } from '../stores/friends';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { useSpeaking } from '../stores/speaking';
import { CountBadge } from './Friends';
import { VolumeMenu } from './MediaStage';
import { Avatar, ICON, IconButton, cx } from './ui';

export function Sidebar() {
  const channels = useCommunity((s) => s.channels);
  const isAdmin = useCommunity((s) => s.me?.role === 'admin');
  const openSettings = useUi((s) => s.openSettings);
  const text = channels.filter((c) => c.kind === 'text');
  const voice = channels.filter((c) => c.kind === 'voice');

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-1">
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <FriendsRow />
        <div className="mx-2 my-3 h-px bg-border" />
        <Group title="Texto" onAdd={isAdmin ? () => openSettings('channels') : undefined} />
        {text.map((c) => (
          <TextChannelRow key={c.id} channel={c} />
        ))}
        {text.length === 0 && <p className="px-2 py-1 text-meta text-text-3">Nenhum canal de texto.</p>}
        <div className="h-4" />
        <Group title="Voz" onAdd={isAdmin ? () => openSettings('channels') : undefined} />
        {voice.map((c) => (
          <VoiceChannelRow key={c.id} channel={c} />
        ))}
        {voice.length === 0 && <p className="px-2 py-1 text-meta text-text-3">Nenhum canal de voz.</p>}
      </nav>
      <UserPanel />
    </aside>
  );
}

function Group({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="flex h-7 items-center justify-between px-2 text-meta font-semibold tracking-wide text-text-3 uppercase">
      {title}
      {onAdd && <IconButton icon={Plus} label="Gerenciar canais" size={14} className="size-6" onClick={onAdd} />}
    </div>
  );
}

function FriendsRow() {
  const active = useUi((s) => s.view === 'friends');
  const setView = useUi((s) => s.setView);
  const incoming = useIncomingCount();
  return (
    <button
      type="button"
      onClick={() => setView('friends')}
      className={cx(
        'relative flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-body font-medium transition-colors duration-150',
        active ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1',
      )}
    >
      <ActivePill on={active} />
      <Users {...ICON} className="shrink-0" />
      <span className="flex-1 truncate">Amigos</span>
      {incoming > 0 && <CountBadge n={incoming} />}
    </button>
  );
}

const TextChannelRow = memo(function TextChannelRow({ channel }: { channel: Channel }) {
  const active = useUi((s) => s.view === 'chat' && s.channelId === channel.id);
  const select = useUi((s) => s.selectChannel);
  return (
    <button
      type="button"
      onClick={() => select(channel.id)}
      className={cx(
        'relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body transition-colors duration-150',
        active ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1',
      )}
    >
      <ActivePill on={active} />
      <Hash {...ICON} className="shrink-0 text-text-3" />
      <span className="truncate">{channel.name}</span>
    </button>
  );
});

const VoiceChannelRow = memo(function VoiceChannelRow({ channel }: { channel: Channel }) {
  const joined = useVoice((s) => s.channelId === channel.id);
  const join = useVoice((s) => s.join);
  const setView = useUi((s) => s.setView);
  const ids = useCommunity(
    useShallow((s) =>
      Object.values(s.voiceStates)
        .filter((v) => v.channel_id === channel.id)
        .map((v) => v.user_id)
        .sort(),
    ),
  );
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={() => {
          join(channel.id);
          setView('call');
        }}
        className={cx(
          'relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body transition-colors duration-150',
          joined ? 'text-text-1 hover:bg-bg-2' : 'text-text-2 hover:bg-bg-2 hover:text-text-1',
        )}
      >
        <ActivePill on={joined} tone="ok" />
        <Volume2 {...ICON} className={cx('shrink-0 transition-colors duration-150', joined ? 'text-ok' : 'text-text-3')} />
        <span className="truncate">{channel.name}</span>
      </button>
      {ids.length > 0 && (
        <ul className="mb-1 ml-7 space-y-0.5">
          {ids.map((id) => (
            <VoiceParticipant key={id} userId={id} />
          ))}
        </ul>
      )}
    </div>
  );
});

const VoiceParticipant = memo(function VoiceParticipant({ userId }: { userId: string }) {
  const member = useCommunity((s) => s.members[userId]);
  const state = useCommunity((s) => s.voiceStates[userId]);
  const speaking = useSpeaking((s) => s.ids.has(userId));
  const isMe = useCommunity((s) => s.me?.id === userId);
  if (!member || !state) return null;
  const row = (
    <li className="flex h-7 animate-[rise_180ms_ease-out] items-center gap-2 rounded-md px-1 text-body text-text-2 transition-colors duration-150 hover:bg-bg-2">
      <Avatar id={member.id} name={member.display_name} url={member.avatar_url} size={20} ring={speaking && !state.self_mute} />
      <span className="flex-1 truncate">{member.display_name}</span>
      {state.self_deaf ? (
        <HeadphoneOff size={14} strokeWidth={1.75} className="text-danger" aria-label="Ensurdecido" />
      ) : state.self_mute ? (
        <MicOff size={14} strokeWidth={1.75} className="text-danger" aria-label="Mudo" />
      ) : null}
    </li>
  );
  return isMe ? row : <VolumeMenu userId={userId}>{row}</VolumeMenu>;
});

function UserPanel() {
  const me = useCommunity((s) => s.me);
  const { selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice(
    useShallow((s) => ({ selfMute: s.selfMute, selfDeaf: s.selfDeaf, toggleMute: s.toggleMute, toggleDeaf: s.toggleDeaf })),
  );
  const openSettings = useUi((s) => s.openSettings);
  const status = useCommunity((s) => s.status);
  const label = useMemo(
    () => (status === 'connected' ? 'Online' : status === 'reconnecting' ? 'Reconectando…' : 'Conectando…'),
    [status],
  );
  if (!me) return null;
  return (
    <div className="flex h-14 items-center gap-2 border-t border-border bg-bg-0/40 px-2">
      <div className="relative">
        <Avatar id={me.id} name={me.display_name} url={me.avatar_url} size={32} />
        <span
          className={cx(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-bg-1 transition-colors duration-300',
            status === 'connected' ? 'bg-ok' : 'bg-warn',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold">{me.display_name}</div>
        <div className={cx('truncate text-meta', status === 'connected' ? 'text-text-3' : 'text-warn')}>{label}</div>
      </div>
      <IconButton icon={selfMute ? MicOff : Mic} label={selfMute ? 'Ativar microfone' : 'Silenciar'} danger={selfMute} active={selfMute} onClick={toggleMute} />
      <IconButton
        icon={selfDeaf ? HeadphoneOff : Headphones}
        label={selfDeaf ? 'Ativar áudio' : 'Ensurdecer'}
        danger={selfDeaf}
        active={selfDeaf}
        onClick={toggleDeaf}
      />
      <IconButton icon={Settings} label="Configurações" onClick={() => openSettings('account')} />
    </div>
  );
}

/** Discord-style marker at the sidebar's left edge for the open (or joined) row. */
function ActivePill({ on, tone = 'accent' }: { on: boolean; tone?: 'accent' | 'ok' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'absolute top-1/2 -left-2 h-5 w-1 -translate-y-1/2 rounded-r-full transition-[scale,opacity] duration-200 ease-out',
        tone === 'ok' ? 'bg-ok' : 'bg-accent',
        on ? 'scale-100 opacity-100' : 'scale-y-0 opacity-0',
      )}
    />
  );
}
