import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { boot } from './app/boot';
import { Login } from './components/Login';
import { Titlebar } from './components/Titlebar';
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
      {status === 'signed_in' ? (
        <Workspace />
      ) : status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-text-3">
          <Loader2 size={22} className="animate-spin" />
        </div>
      ) : (
        <Login />
      )}
    </div>
  );
}
