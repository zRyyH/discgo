import { Titlebar } from './components/Titlebar';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <Titlebar title="DiscGo" />
      <main className="flex flex-1 items-center justify-center bg-bg-2">
        <p className="text-text-3">DiscGo</p>
      </main>
    </div>
  );
}
