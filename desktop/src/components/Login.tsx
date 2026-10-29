import { useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { openExternal } from '../shared/shell';
import { useSession } from '../stores/session';
import { Button, Input } from './ui';

export function Login() {
  const { status, error, invite, setInvite, startGoogle, devLogin } = useSession();
  const busy = status === 'signing_in';

  return (
    <div className="flex flex-1 items-center justify-center bg-bg-0">
      <div className="w-[380px] rounded-lg border border-border bg-bg-2 p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-bg-3">
            <div className="size-5 rounded-full border-[3px] border-accent" />
          </div>
          <div>
            <h1 className="text-title font-semibold">Entrar no DiscGo</h1>
            <p className="text-meta text-text-2">Use sua conta Google.</p>
          </div>
        </div>

        <label className="mb-1 block text-meta font-semibold text-text-2" htmlFor="invite">
          Código de convite <span className="font-normal text-text-3">(só no primeiro acesso)</span>
        </label>
        <Input
          id="invite"
          value={invite}
          placeholder="ex.: k7m2q9x4pa"
          spellCheck={false}
          onChange={(e) => setInvite(e.target.value)}
          className="mb-4"
        />

        <Button className="w-full" disabled={busy} onClick={() => void startGoogle(openExternal)}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} strokeWidth={1.75} />}
          Entrar com Google
        </Button>

        {status === 'waiting_browser' && (
          <p className="mt-4 text-meta text-text-2">Continue no navegador. O DiscGo abre sozinho quando o login terminar.</p>
        )}
        {error && <p className="mt-4 text-meta text-danger">{error}</p>}

        {import.meta.env.DEV && <DevLogin onLogin={devLogin} busy={busy} />}
      </div>
    </div>
  );
}

/** Google-free login against an API started with AUTH_DEV=true. */
function DevLogin({ onLogin, busy }: { onLogin: (email: string, name: string) => Promise<void>; busy: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="mt-6 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (email) void onLogin(email, name);
      }}
    >
      <p className="mb-2 text-meta font-semibold text-warn">Login de desenvolvimento</p>
      <div className="flex gap-2">
        <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input placeholder="nome" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button type="submit" variant="ghost" className="mt-2 w-full" disabled={busy || !email}>
        Entrar sem Google
      </Button>
    </form>
  );
}
