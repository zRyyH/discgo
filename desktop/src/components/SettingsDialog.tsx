import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, Hash, Trash2, Volume2, X } from 'lucide-react';
import { api, ApiError } from '../api/rest';
import type { Channel, Invite } from '../shared/protocol';
import { appVersion } from '../shared/shell';
import { useCommunity } from '../stores/community';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { useUi, type SettingsSection } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { VoiceSettings } from './VoiceSettings';
import { Avatar, Button, IconButton, Input, Toggle, cx } from './ui';

const sections: { id: SettingsSection; label: string; admin?: boolean }[] = [
  { id: 'account', label: 'Minha conta' },
  { id: 'voice', label: 'Voz e vídeo' },
  { id: 'notifications', label: 'Sons' },
  { id: 'invites', label: 'Convites', admin: true },
  { id: 'channels', label: 'Canais', admin: true },
  { id: 'members', label: 'Membros', admin: true },
];

export function SettingsDialog() {
  const section = useUi((s) => s.settingsOpen);
  const open = useUi((s) => s.openSettings);
  const isAdmin = useCommunity((s) => s.me?.role === 'admin');
  return (
    <Dialog.Root open={section !== null} onOpenChange={(o) => !o && open(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(640px,85vh)] w-[min(880px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-bg-2 shadow-popover">
          <nav className="w-52 shrink-0 border-r border-border bg-bg-1 p-3">
            <Dialog.Title className="mb-2 px-2 text-meta font-semibold tracking-wide text-text-3 uppercase">Configurações</Dialog.Title>
            {sections
              .filter((s) => !s.admin || isAdmin)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => open(s.id)}
                  className={cx(
                    'mb-0.5 block h-8 w-full rounded-md px-2 text-left text-body transition-colors',
                    section === s.id ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1',
                  )}
                >
                  {s.label}
                </button>
              ))}
          </nav>
          <div className="relative flex-1 overflow-y-auto p-6">
            <Dialog.Close asChild>
              <IconButton icon={X} label="Fechar" className="absolute top-3 right-3" />
            </Dialog.Close>
            <Dialog.Description className="sr-only">Preferências do DiscGo</Dialog.Description>
            {section === 'account' && <Account />}
            {section === 'voice' && <VoiceSettings />}
            {section === 'notifications' && <Sounds />}
            {section === 'invites' && isAdmin && <Invites />}
            {section === 'channels' && isAdmin && <Channels />}
            {section === 'members' && isAdmin && <Members />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-title font-semibold">{children}</h2>;
}

function Account() {
  const me = useCommunity((s) => s.me);
  const logout = useSession((s) => s.logout);
  const [version, setVersion] = useState('');
  useEffect(() => void appVersion().then(setVersion).catch(() => {}), []);
  if (!me) return null;
  return (
    <>
      <Heading>Minha conta</Heading>
      <div className="flex items-center gap-4 rounded-lg bg-bg-1 p-4">
        <Avatar id={me.id} name={me.display_name} url={me.avatar_url} size={64} />
        <div className="min-w-0 flex-1">
          <div className="text-title font-semibold">{me.display_name}</div>
          <div className="text-body text-text-2">{me.email}</div>
          <div className="text-meta text-text-3">{me.role === 'admin' ? 'Admin' : 'Membro'}</div>
        </div>
        <Button variant="danger" onClick={() => void logout()}>
          Sair
        </Button>
      </div>
      <p className="mt-6 text-meta text-text-3">DiscGo {version}</p>
    </>
  );
}

function Sounds() {
  const sounds = useSettings((s) => s.sounds);
  const update = useSettings((s) => s.update);
  return (
    <>
      <Heading>Sons</Heading>
      <Toggle label="Sons de entrar, sair e silenciar" checked={sounds} onChange={(v) => update({ sounds: v })} />
    </>
  );
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => void reload(), deps);
  return { data, error, reload, setError };
}

function Invites() {
  const { data: invites, error, reload, setError } = useAsync(api.invites, []);
  const [maxUses, setMaxUses] = useState('');
  const [hours, setHours] = useState('168');
  const [copied, setCopied] = useState<string | null>(null);

  const create = async () => {
    try {
      await api.createInvite({
        max_uses: maxUses ? Number(maxUses) : undefined,
        expires_in_hours: hours ? Number(hours) : undefined,
      });
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const copy = (inv: Invite) => {
    void navigator.clipboard.writeText(inv.code);
    setCopied(inv.code);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <Heading>Convites</Heading>
      <p className="mb-4 text-body text-text-2">Quem entra pela primeira vez informa o código na tela de login.</p>
      <div className="mb-6 flex items-end gap-2">
        <Field label="Usos (vazio = ilimitado)">
          <Input value={maxUses} inputMode="numeric" onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Validade em horas (vazio = sem prazo)">
          <Input value={hours} inputMode="numeric" onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Button onClick={() => void create()}>Criar convite</Button>
      </div>
      {error && <p className="mb-3 text-meta text-danger">{error}</p>}
      <div className="divide-y divide-border rounded-lg border border-border">
        {invites?.length === 0 && <p className="p-4 text-body text-text-3">Nenhum convite.</p>}
        {invites?.map((inv) => (
          <div key={inv.code} className="flex items-center gap-3 px-4 py-2">
            <code className="font-mono text-body">{inv.code}</code>
            <span className="flex-1 text-meta text-text-3">
              {inv.uses}
              {inv.max_uses ? `/${inv.max_uses}` : ''} usos
              {inv.expires_at ? ` · expira ${new Date(inv.expires_at).toLocaleString('pt-BR')}` : ' · sem prazo'}
            </span>
            <IconButton icon={copied === inv.code ? Check : Copy} label="Copiar código" onClick={() => copy(inv)} />
            <IconButton icon={Trash2} label="Apagar convite" danger onClick={() => void api.deleteInvite(inv.code).then(reload)} />
          </div>
        ))}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-meta font-semibold text-text-2">{label}</span>
      {children}
    </label>
  );
}

function Channels() {
  const channels = useCommunity((s) => s.channels);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Channel['kind']>('text');
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Channel | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));

  return (
    <>
      <Heading>Canais</Heading>
      <form
        className="mb-6 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void run(api.createChannel(kind, name.trim()).then(() => setName('')));
        }}
      >
        <Field label="Nome do canal">
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex h-9 overflow-hidden rounded-md border border-border">
          {(['text', 'voice'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cx('px-3 text-body', kind === k ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:text-text-1')}
            >
              {k === 'text' ? 'Texto' : 'Voz'}
            </button>
          ))}
        </div>
        <Button type="submit">Criar</Button>
      </form>
      {error && <p className="mb-3 text-meta text-danger">{error}</p>}
      <div className="divide-y divide-border rounded-lg border border-border">
        {channels.map((c) => (
          <ChannelRow key={c.id} channel={c} onDelete={() => setToDelete(c)} onRename={(n) => void run(api.updateChannel(c.id, { name: n }))} />
        ))}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Apagar canal"
        text={`O canal ${toDelete?.name ?? ''} e todas as mensagens dele serão apagados.`}
        confirm="Apagar canal"
        onConfirm={() => toDelete && void run(api.deleteChannel(toDelete.id))}
      />
    </>
  );
}

function ChannelRow({ channel, onDelete, onRename }: { channel: Channel; onDelete: () => void; onRename: (name: string) => void }) {
  const [name, setName] = useState(channel.name);
  useEffect(() => setName(channel.name), [channel.name]);
  const Icon = channel.kind === 'text' ? Hash : Volume2;
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
      <Input
        value={name}
        maxLength={100}
        className="h-8 border-transparent bg-transparent focus:bg-bg-0"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== channel.name && onRename(name.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <IconButton icon={Trash2} label="Apagar canal" danger onClick={onDelete} />
    </div>
  );
}

function Members() {
  const members = useCommunity((s) => s.members);
  const myId = useCommunity((s) => s.me?.id);
  const [error, setError] = useState<string | null>(null);
  const list = Object.values(members).sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'));
  return (
    <>
      <Heading>Membros</Heading>
      {error && <p className="mb-3 text-meta text-danger">{error}</p>}
      <div className="divide-y divide-border rounded-lg border border-border">
        {list.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-4 py-2">
            <Avatar id={m.id} name={m.display_name} url={m.avatar_url} size={28} />
            <span className="flex-1 truncate text-body">{m.display_name}</span>
            <Button
              variant="ghost"
              className="h-8 px-3"
              disabled={m.id === myId}
              onClick={() =>
                void api
                  .setRole(m.id, m.role === 'admin' ? 'member' : 'admin')
                  .then(() => setError(null))
                  .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
              }
            >
              {m.role === 'admin' ? 'Remover admin' : 'Tornar admin'}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
