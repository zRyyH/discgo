import { useEffect } from 'react';
import { Hash, Loader2, MessagesSquare, Users } from 'lucide-react';
import { useCommunity } from '../stores/community';
import { useSettings } from '../stores/settings';
import { useUi } from '../stores/ui';
import { Composer } from './Composer';
import { MemberList } from './MemberList';
import { MessageList } from './MessageList';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import { EmptyState, ICON, IconButton } from './ui';

export function Workspace() {
  const ready = useCommunity((s) => s.ready);
  const status = useCommunity((s) => s.status);
  useDefaultChannel();

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bg-2 text-text-3">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status === 'reconnecting' && (
        <div className="bg-warn/15 px-4 py-1 text-center text-meta text-warn">Conexão perdida. Reconectando…</div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Main />
      </div>
      <SettingsDialog />
    </div>
  );
}

function Main() {
  const channelId = useUi((s) => s.channelId);
  const channel = useCommunity((s) => s.channels.find((c) => c.id === channelId && c.kind === 'text'));
  const showMembers = useSettings((s) => s.showMembers);
  const update = useSettings((s) => s.update);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg-2">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {channel && (
          <>
            <Hash {...ICON} className="text-text-3" />
            <h2 className="truncate text-title font-semibold">{channel.name}</h2>
          </>
        )}
        <div className="flex-1" />
        <IconButton icon={Users} label={showMembers ? 'Ocultar membros' : 'Mostrar membros'} active={showMembers} onClick={() => update({ showMembers: !showMembers })} />
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {channel ? (
            <>
              <MessageList key={channel.id} channelId={channel.id} />
              <Composer channelId={channel.id} channelName={channel.name} />
            </>
          ) : (
            <EmptyState icon={MessagesSquare} text="Escolha um canal de texto." />
          )}
        </div>
        {showMembers && <MemberList />}
      </div>
    </div>
  );
}

/** Opens the last used text channel (or the first one) and remembers the choice. */
function useDefaultChannel() {
  const channels = useCommunity((s) => s.channels);
  const channelId = useUi((s) => s.channelId);
  const select = useUi((s) => s.selectChannel);
  const last = useSettings((s) => s.lastTextChannel);
  const update = useSettings((s) => s.update);

  useEffect(() => {
    const text = channels.filter((c) => c.kind === 'text');
    if (channelId && text.some((c) => c.id === channelId)) return;
    const next = text.find((c) => c.id === last) ?? text[0];
    if (next || channelId) select(next?.id ?? null);
  }, [channels, channelId, last, select]);

  useEffect(() => {
    if (channelId && channelId !== last) update({ lastTextChannel: channelId });
  }, [channelId, last, update]);
}
