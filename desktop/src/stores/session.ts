// Login state (PLAN 3.1 step 1): token in the Windows Credential Manager,
// one-time code from the discgo://auth deep link, gateway started on sign-in.
import { create } from 'zustand';
import { ApiError, api, setToken, setUnauthorizedHandler } from '../api/rest';
import { gateway } from '../api/gateway';
import { session } from '../shared/shell';
import { useCommunity } from './community';
import { useMessages } from './messages';

type Status = 'loading' | 'signed_out' | 'waiting_browser' | 'signing_in' | 'signed_in';

interface SessionState {
  status: Status;
  error: string | null;
  invite: string;
  init: () => Promise<void>;
  setInvite: (code: string) => void;
  startGoogle: (open: (url: string) => Promise<void>) => Promise<void>;
  loginWithCode: (code: string) => Promise<void>;
  devLogin: (email: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
}

function start(token: string) {
  setToken(token);
  gateway.connect(token);
}

async function signOutLocally() {
  gateway.close();
  setToken(null);
  await session.clear().catch(() => {});
  useCommunity.getState().reset();
  useMessages.getState().reset();
}

const loginErrors: Record<string, string> = {
  invite_required: 'Esta conta ainda não faz parte da comunidade: informe um código de convite.',
  invite_invalid: 'O convite é inválido, expirou ou já foi usado.',
  invalid_code: 'O login expirou. Tente de novo.',
  network: 'Sem conexão com o servidor.',
};

const message = (e: unknown) =>
  e instanceof ApiError ? (loginErrors[e.code] ?? e.message) : 'Não foi possível entrar.';

export const useSession = create<SessionState>()((set, get) => {
  const expired = () => {
    void signOutLocally();
    set({ status: 'signed_out', error: 'Sua sessão expirou. Entre de novo.' });
  };
  setUnauthorizedHandler(expired);
  gateway.onUnauthorized(expired);

  return {
    status: 'loading',
    error: null,
    invite: '',
    init: async () => {
      const token = await session.get().catch(() => null);
      if (!token) {
        set({ status: 'signed_out' });
        return;
      }
      start(token);
      set({ status: 'signed_in' });
    },
    setInvite: (invite) => set({ invite: invite.trim() }),
    startGoogle: async (open) => {
      set({ status: 'waiting_browser', error: null });
      await open(api.googleStartUrl(get().invite)).catch(() =>
        set({ status: 'signed_out', error: 'Não foi possível abrir o navegador.' }),
      );
    },
    loginWithCode: async (code) => {
      set({ status: 'signing_in', error: null });
      try {
        const { token } = await api.exchange(code);
        await session.set(token);
        start(token);
        set({ status: 'signed_in', invite: '' });
      } catch (e) {
        set({ status: 'signed_out', error: message(e) });
      }
    },
    devLogin: async (email, name) => {
      set({ status: 'signing_in', error: null });
      try {
        const { code } = await api.devLogin(email, name, get().invite);
        await get().loginWithCode(code);
      } catch (e) {
        set({ status: 'signed_out', error: message(e) });
      }
    },
    logout: async () => {
      await api.logout().catch(() => {});
      await signOutLocally();
      set({ status: 'signed_out', error: null });
    },
  };
});
