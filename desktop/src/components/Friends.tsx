// Friends view: friends online / all, pending requests, and "add friend" by
// username (the Gmail address without "@gmail.com").
import { memo, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Inbox, Loader2, UserMinus, UserPlus, Users, X, type LucideIcon } from 'lucide-react';
import { api, ApiError } from '../api/rest';
import type { Relationship } from '../shared/protocol';
import { useCommunity } from '../stores/community';
import { useFriends } from '../stores/friends';
import { ConfirmDialog } from './ConfirmDialog';
import { Avatar, Button, ICON, Tip, cx } from './ui';

type Tab = 'online' | 'all' | 'pending' | 'add';

const byName = (a: Relationship, b: Relationship) => a.user.display_name.localeCompare(b.user.display_name, 'pt-BR');

export function FriendsPane() {
  const relationships = useFriends((s) => s.relationships);
  const members = useCommunity((s) => s.members);
  const [tab, setTab] = useState<Tab>(() => {
    const all = Object.values(useFriends.getState().relationships);
    if (all.some((r) => r.type === 'incoming')) return 'pending';
    return all.some((r) => r.type === 'friend') ? 'online' : 'add';
  });
  const [toRemove, setToRemove] = useState<Relationship | null>(null);

  const lists = useMemo(() => {
    const all = Object.values(relationships).sort(byName);
    const friends = all.filter((r) => r.type === 'friend');
    return {
      friends,
      online: friends.filter((r) => members[r.user.id]?.status === 'online'),
      incoming: all.filter((r) => r.type === 'incoming'),
      outgoing: all.filter((r) => r.type === 'outgoing'),
    };
  }, [relationships, members]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-4">
        <Users {...ICON} className="mr-1 text-text-3" />
        <h2 className="mr-3 text-title font-semibold">Amigos</h2>
        <div className="mr-2 h-5 w-px bg-border" />
        <TabButton active={tab === 'online'} onClick={() => setTab('online')}>
          Online
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
          Todos
        </TabButton>
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')} badge={lists.incoming.length}>
          Pendentes
        </TabButton>
        <button
          type="button"
          onClick={() => setTab('add')}
          className={cx(
            'ml-2 flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-body font-semibold transition-colors duration-150',
            tab === 'add' ? 'bg-accent/15 text-accent' : 'bg-accent text-bg-0 hover:brightness-110',
          )}
        >
          <UserPlus size={15} strokeWidth={2} />
          Adicionar amigo
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'add' && <AddFriend />}
        {tab === 'online' && (
          <List
            title={`Online — ${lists.online.length}`}
            items={lists.online}
            empty={{ icon: Users, text: lists.friends.length ? 'Nenhum amigo online agora.' : 'Você ainda não tem amigos por aqui.' }}
            onEmptyAction={lists.friends.length ? undefined : () => setTab('add')}
            onRemove={setToRemove}
          />
        )}
        {tab === 'all' && (
          <List
            title={`Todos os amigos — ${lists.friends.length}`}
            items={lists.friends}
            empty={{ icon: Users, text: 'Você ainda não tem amigos por aqui.' }}
            onEmptyAction={() => setTab('add')}
            onRemove={setToRemove}
          />
        )}
        {tab === 'pending' &&
          (lists.incoming.length + lists.outgoing.length === 0 ? (
            <Empty icon={Inbox} text="Nenhum pedido de amizade pendente." />
          ) : (
            <div className="px-6 py-4">
              {lists.incoming.length > 0 && <Section title={`Recebidos — ${lists.incoming.length}`} items={lists.incoming} onRemove={setToRemove} />}
              {lists.outgoing.length > 0 && <Section title={`Enviados — ${lists.outgoing.length}`} items={lists.outgoing} onRemove={setToRemove} />}
            </div>
          ))}
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(o) => !o && setToRemove(null)}
        title="Remover amigo"
        text={`Tem certeza de que quer remover ${toRemove?.user.display_name ?? ''} dos seus amigos?`}
        confirm="Remover amigo"
        onConfirm={() => toRemove && void api.removeFriend(toRemove.user.id).catch(() => {})}
      />
    </div>
  );
}

function TabButton({ active, onClick, badge, children }: { active: boolean; onClick: () => void; badge?: number; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-body font-medium transition-colors duration-150',
        active ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:bg-bg-3/60 hover:text-text-1',
      )}
    >
      {children}
      {!!badge && <CountBadge n={badge} />}
    </button>
  );
}

export function CountBadge({ n }: { n: number }) {
  return (
    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[11px] leading-none font-bold text-white">
      {n > 99 ? '99+' : n}
    </span>
  );
}

function List(props: {
  title: string;
  items: Relationship[];
  empty: { icon: LucideIcon; text: string };
  onEmptyAction?: () => void;
  onRemove: (r: Relationship) => void;
}) {
  if (props.items.length === 0) return <Empty {...props.empty} action={props.onEmptyAction} />;
  return (
    <div className="px-6 py-4">
      <Section title={props.title} items={props.items} onRemove={props.onRemove} />
    </div>
  );
}

function Section({ title, items, onRemove }: { title: string; items: Relationship[]; onRemove: (r: Relationship) => void }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 px-3 text-meta font-semibold tracking-wide text-text-3 uppercase">{title}</h3>
      <ul>
        {items.map((r) => (
          <FriendRow key={r.user.id} rel={r} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}

const FriendRow = memo(function FriendRow({ rel, onRemove }: { rel: Relationship; onRemove: (r: Relationship) => void }) {
  // Prefer the live member (fresh name, photo and presence).
  const member = useCommunity((s) => s.members[rel.user.id]);
  const user = member ?? rel.user;
  const online = member?.status === 'online';
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.catch(() => {}).finally(() => setBusy(false));
  };
  const subtitle =
    rel.type === 'incoming' ? 'Pedido de amizade recebido' : rel.type === 'outgoing' ? 'Pedido de amizade enviado' : online ? 'Online' : 'Offline';

  return (
    <li className="group flex h-[60px] items-center gap-3 rounded-md border-t border-border px-3 transition-colors duration-150 first:border-t-0 hover:border-transparent hover:bg-bg-3/60 [&:hover+li]:border-transparent">
      <div className="relative">
        <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={36} />
        {rel.type === 'friend' && (
          <span
            className={cx(
              'absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-[3px] border-bg-2 group-hover:border-bg-3',
              online ? 'bg-ok' : 'bg-text-3',
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-msg font-semibold text-text-1">{user.display_name}</span>
          <span className="truncate text-meta text-text-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100">{user.username}</span>
        </div>
        <div className="truncate text-meta text-text-2">{subtitle}</div>
      </div>
      <div className="flex gap-2">
        {rel.type === 'incoming' && (
          <RoundAction icon={Check} label="Aceitar" tone="ok" disabled={busy} onClick={() => run(api.acceptFriend(user.id))} />
        )}
        {rel.type === 'incoming' && (
          <RoundAction icon={X} label="Recusar" tone="danger" disabled={busy} onClick={() => run(api.removeFriend(user.id))} />
        )}
        {rel.type === 'outgoing' && (
          <RoundAction icon={X} label="Cancelar pedido" tone="danger" disabled={busy} onClick={() => run(api.removeFriend(user.id))} />
        )}
        {rel.type === 'friend' && <RoundAction icon={UserMinus} label="Remover amigo" tone="danger" onClick={() => onRemove(rel)} />}
      </div>
    </li>
  );
});

function RoundAction(props: { icon: LucideIcon; label: string; tone: 'ok' | 'danger'; disabled?: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <Tip label={props.label}>
      <button
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onClick}
        className={cx(
          'flex size-9 items-center justify-center rounded-full bg-bg-1 text-text-2 transition-colors duration-150 disabled:opacity-40',
          props.tone === 'ok' ? 'hover:text-ok' : 'hover:text-danger',
        )}
      >
        <Icon size={18} strokeWidth={2} />
      </button>
    </Tip>
  );
}

function Empty({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-bg-1 text-text-3">
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <p className="text-body text-text-2">{text}</p>
      {action && (
        <Button onClick={action}>
          <UserPlus size={16} strokeWidth={2} />
          Adicionar amigo
        </Button>
      )}
    </div>
  );
}

const addErrors: Record<string, string> = {
  user_not_found: 'Não achamos ninguém com esse usuário. Confira se digitou o Gmail certo, sem o @gmail.com.',
  self_request: 'Esse é o seu próprio usuário.',
  already_friends: 'Vocês já são amigos.',
  already_requested: 'Você já mandou um pedido para essa pessoa. Agora é esperar ela aceitar.',
  network: 'Sem conexão com o servidor.',
};

function AddFriend() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = username.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const rel = await api.addFriend(value);
      setResult({
        ok: true,
        text:
          rel.type === 'friend'
            ? `${rel.user.display_name} já tinha te mandado um pedido: agora vocês são amigos!`
            : `Pedido enviado para ${rel.user.display_name}.`,
      });
      setUsername('');
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? (addErrors[err.code] ?? err.message) : 'Não foi possível enviar o pedido.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[720px] px-8 py-7">
      <h2 className="text-[17px] font-semibold">Adicionar amigo</h2>
      <p className="mt-1 text-body text-text-2">
        Digite o usuário da pessoa. É o Gmail dela sem o <span className="font-mono text-text-1">@gmail.com</span>.
      </p>

      <form onSubmit={(e) => void submit(e)} className="mt-4">
        <div
          className={cx(
            'flex h-[52px] items-center gap-2 rounded-md border bg-bg-0 pr-2 pl-4 transition-colors duration-150',
            result && !result.ok ? 'border-danger' : result?.ok ? 'border-ok' : 'border-border focus-within:border-accent',
          )}
        >
          <input
            autoFocus
            value={username}
            spellCheck={false}
            autoComplete="off"
            placeholder="ex.: joao.silva"
            onChange={(e) => {
              setUsername(e.target.value);
              setResult(null);
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-msg text-text-1 outline-none placeholder:text-text-3"
          />
          <Button type="submit" disabled={!username.trim() || busy} className="h-9">
            {busy && <Loader2 size={15} className="animate-spin" />}
            Enviar pedido de amizade
          </Button>
        </div>
        {result && <p className={cx('mt-2 text-meta', result.ok ? 'text-ok' : 'text-danger')}>{result.text}</p>}
      </form>

      <MyUsername />
    </div>
  );
}

function MyUsername() {
  const me = useCommunity((s) => s.me);
  const [copied, setCopied] = useState(false);
  if (!me) return null;
  const username = me.username;
  return (
    <div className="mt-8 flex items-center gap-4 rounded-lg border border-border bg-bg-1 p-4">
      <Avatar id={me.id} name={me.display_name} url={me.avatar_url} size={44} />
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold text-text-1">Seu usuário</div>
        <div className="text-meta text-text-2">Passe para os seus amigos te adicionarem.</div>
      </div>
      <code className="truncate rounded-sm bg-bg-0 px-2.5 py-1.5 font-mono text-body text-text-1 select-text">{username}</code>
      <Tip label={copied ? 'Copiado!' : 'Copiar usuário'}>
        <button
          type="button"
          aria-label="Copiar usuário"
          onClick={() => {
            void navigator.clipboard.writeText(username);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex size-9 items-center justify-center rounded-md text-text-2 transition-colors duration-150 hover:bg-bg-3 hover:text-text-1"
        >
          {copied ? <Check size={18} strokeWidth={2} className="text-ok" /> : <Copy {...ICON} />}
        </button>
      </Tip>
    </div>
  );
}
