// Sign-in screen (PLAN 3.1): the Google login runs in the system browser and
// comes back through the discgo://auth deep link. Accounts are created on the
// first login, with the Google name and photo.
import { useState } from 'react';
import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react';
import { openExternal } from '../shared/shell';
import { useSession } from '../stores/session';
import { Button, Input, cx } from './ui';

export function Login() {
  const { status, error, startGoogle, cancelGoogle, devLogin } = useSession();
  const google = () => void startGoogle(openExternal);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-y-auto bg-bg-0">
      <Backdrop />
      <div className="relative m-auto w-[420px] animate-[rise_260ms_ease-out] py-8">
        <div className="rounded-[20px] border border-border bg-bg-1 px-9 pt-10 pb-8 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
          <BrandMark />
          <h1 className="mt-6 text-[24px] leading-tight font-semibold tracking-tight">Bem-vindo ao DiscGo</h1>
          <p className="mt-2 text-msg text-text-2">Voz, vídeo e tela compartilhada com seus amigos, com qualidade alta e pouco atraso.</p>

          {status === 'waiting_browser' ? (
            <WaitingBrowser onRetry={google} onCancel={cancelGoogle} />
          ) : (
            <GoogleButton busy={status === 'signing_in'} onClick={google} />
          )}

          {error && (
            <div role="alert" className="mt-4 flex gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-meta text-danger">
              <AlertCircle size={16} strokeWidth={2} className="mt-px shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <UsernameHint />
        </div>
        <p className="mt-5 px-6 text-center text-meta text-text-3">
          Ao continuar, o Google compartilha seu nome, seu e-mail e sua foto de perfil com o DiscGo.
        </p>
        {import.meta.env.DEV && <DevLogin onLogin={devLogin} busy={status === 'signing_in'} />}
      </div>
    </div>
  );
}

/** Two soft glows and a faded dot grid; static, so it costs nothing after the first paint. */
function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-56 -left-48 size-[720px] rounded-full bg-[radial-gradient(closest-side,rgba(139,156,255,0.16),transparent)]" />
      <div className="absolute -right-40 -bottom-64 size-[640px] rounded-full bg-[radial-gradient(closest-side,rgba(61,220,151,0.08),transparent)]" />
      <div className="absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)] bg-[radial-gradient(rgba(231,233,240,0.07)_1px,transparent_1px)] [background-size:22px_22px]" />
    </div>
  );
}

function BrandMark() {
  return (
    <div className="relative flex size-14 items-center justify-center rounded-2xl border border-border bg-bg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="size-7 rounded-full border-[5px] border-accent" />
      <span className="absolute right-2 bottom-2 size-3 rounded-full border-[3px] border-bg-3 bg-ok" />
    </div>
  );
}

/** Google's "Continue with Google" button, light theme (Google sign-in branding guidelines). */
function GoogleButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cx(
        'mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-md border border-[#747775] bg-white px-4 text-[14px] font-semibold text-[#1f1f1f]',
        'transition-colors duration-150 hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-70',
      )}
    >
      {busy ? <Loader2 size={18} className="animate-spin text-[#1f1f1f]" /> : <GoogleLogo />}
      {busy ? 'Entrando…' : 'Continuar com o Google'}
    </button>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function WaitingBrowser({ onRetry, onCancel }: { onRetry: () => void; onCancel: () => void }) {
  return (
    <div className="mt-8 rounded-lg border border-border bg-bg-2 p-5">
      <div className="flex items-center gap-3">
        <div className="relative size-9 shrink-0">
          <div className="absolute inset-0 rounded-full border-[3px] border-bg-3" />
          <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-transparent border-t-accent" />
        </div>
        <div>
          <div className="text-body font-semibold text-text-1">Continue no navegador</div>
          <div className="text-meta text-text-2">Abrimos o login do Google numa aba nova.</div>
        </div>
      </div>
      <ol className="mt-4 space-y-2 text-meta text-text-2">
        <Step n={1}>Escolha a sua conta Google.</Step>
        <Step n={2}>Permita abrir o DiscGo, se o navegador perguntar.</Step>
        <Step n={3}>Pronto: o DiscGo volta sozinho para cá.</Step>
      </ol>
      <div className="mt-5 flex gap-2">
        <Button variant="ghost" className="h-8 flex-1 px-3" onClick={onRetry}>
          Abrir de novo
        </Button>
        <Button variant="ghost" className="h-8 flex-1 px-3" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-3 text-[11px] font-semibold text-text-1">{n}</span>
      {children}
    </li>
  );
}

function UsernameHint() {
  return (
    <div className="mt-6 rounded-md border border-border bg-bg-0/60 px-4 py-3">
      <div className="text-meta font-semibold text-text-1">Sua conta é criada na hora</div>
      <p className="mt-0.5 text-meta text-text-3">Nome e foto vêm do Google. Seu usuário é o seu Gmail sem o @gmail.com:</p>
      <div className="mt-2.5 flex items-center gap-2 font-mono text-meta">
        <span className="rounded-sm bg-bg-3 px-1.5 py-0.5 text-text-2">joao.silva@gmail.com</span>
        <ArrowRight size={14} strokeWidth={2} className="shrink-0 text-text-3" />
        <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-semibold text-accent">joao.silva</span>
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
      className="mt-6 rounded-lg border border-dashed border-warn/40 p-4"
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
