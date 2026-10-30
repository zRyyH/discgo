import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useShallow } from 'zustand/react/shallow';
import { Check, Copy, Hash, Trash2, Volume2, X } from 'lucide-react';
import { api, ApiError } from '../api/rest';
import type { Channel } from '../shared/protocol';
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
  { id: 'app', label: 'Aplicativo' },
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
            {section === 'app' && <AppBehaviour />}
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
          <div className="flex items-center gap-1 text-body text-text-2">
            <span className="font-mono text-text-1 select-text">{me.username}</span>
            <CopyButton text={me.username} label="Copiar usuário" />
          </div>
          <div className="text-meta text-text-3">
            {me.email} · {me.role === 'admin' ? 'Admin' : 'Membro'}
          </div>
        </div>
        <Button variant="danger" onClick={() => void logout()}>
          Sair
        </Button>
      </div>
      <p className="mt-4 text-meta text-text-3">Nome e foto vêm da sua conta Google e são atualizados a cada login.</p>
      <p className="mt-6 text-meta text-text-3">DiscGo {version}</p>
    </>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? 'Copiado!' : label}
      size={14}
      className="size-6"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    />
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

/** PLAN fase 9D: the tray and starting with Windows. */
function AppBehaviour() {
  const { closeToTray, startWithWindows, update } = useSettings(
    useShallow((s) => ({ closeToTray: s.closeToTray, startWithWindows: s.startWithWindows, update: s.update })),
  );
  return (
    <>
      <Heading>Aplicativo</Heading>
      <Toggle label="Iniciar com o Windows" checked={startWithWindows} onChange={(v) => update({ startWithWindows: v })} />
      <Toggle label="Manter na bandeja ao fechar" checked={closeToTray} onChange={(v) => update({ closeToTray: v })} />
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
