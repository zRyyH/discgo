import { useEffect } from 'react';
import { boot } from './app/boot';
import { Login } from './components/Login';
import { Toaster, UpdateBanner } from './components/Notices';
import { Titlebar } from './components/Titlebar';
import { Splash } from './components/ui';
import { Workspace } from './components/Workspace';
import { useCommunity } from './stores/community';
import { useSession } from './stores/session';

export function App() {
  const status = useSession((s) => s.status);
  const name = useCommunity((s) => s.name);

  useEffect(() => void boot(), []);

  return (
    <div className="flex h-full flex-col">
      <Titlebar title={name || 'DiscGo'} />
      <UpdateBanner />
      <Toaster />
      {status === 'signed_in' ? (
        <Workspace />
      ) : status === 'loading' ? (
        <Splash text="Abrindo…" />
      ) : (
        <Login />
      )}
    </div>
  );
}
