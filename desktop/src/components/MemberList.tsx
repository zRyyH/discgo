import { memo, useMemo } from 'react';
import { Crown } from 'lucide-react';
import { useCommunity } from '../stores/community';
import { Avatar, Tip, cx } from './ui';

export function MemberList() {
  const members = useCommunity((s) => s.members);
  const { online, offline } = useMemo(() => {
    const all = Object.values(members).sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'));
    return {
      online: all.filter((m) => m.status === 'online').map((m) => m.id),
      offline: all.filter((m) => m.status !== 'online').map((m) => m.id),
    };
  }, [members]);
  return (
    <aside className="w-[220px] shrink-0 overflow-y-auto border-l border-border bg-bg-1 px-2 py-3">
      <Section title={`Online — ${online.length}`} ids={online} />
      {offline.length > 0 && <Section title={`Offline — ${offline.length}`} ids={offline} dim />}
    </aside>
  );
}

function Section({ title, ids, dim }: { title: string; ids: string[]; dim?: boolean }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 px-2 text-meta font-semibold tracking-wide text-text-3 uppercase">{title}</h3>
      {ids.map((id) => (
        <MemberRow key={id} id={id} dim={dim} />
      ))}
    </section>
  );
}

const MemberRow = memo(function MemberRow({ id, dim }: { id: string; dim?: boolean }) {
  const m = useCommunity((s) => s.members[id]);
  if (!m) return null;
  return (
    <div className={cx('flex h-10 items-center gap-2.5 rounded-md px-2 transition-colors duration-150 hover:bg-bg-2', dim && 'opacity-45')}>
      <div className="relative">
        <Avatar id={m.id} name={m.display_name} url={m.avatar_url} size={32} />
        {!dim && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-bg-1 bg-ok" />}
      </div>
      <span className="truncate text-body text-text-1">{m.display_name}</span>
      {m.role === 'admin' && (
        <Tip label="Admin">
          <Crown size={13} strokeWidth={1.75} className="shrink-0 text-warn" />
        </Tip>
      )}
    </div>
  );
});
