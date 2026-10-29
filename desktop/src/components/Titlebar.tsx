import { type ReactNode, useEffect, useState } from 'react';
import { Copy, Download, Minus, Square, X } from 'lucide-react';
import { useUpdate } from '../app/updates';
import { windowControls } from '../shared/shell';

const ICON = { size: 14, strokeWidth: 1.75 };

export function Titlebar({ title }: { title: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const sync = () => void windowControls.isMaximized().then(setMaximized);
    sync();
    const unlisten = windowControls.onResized(sync);
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-border bg-bg-1 pl-3"
    >
      <span data-tauri-drag-region className="text-body font-semibold text-text-2">
        {title}
      </span>
      <div data-tauri-drag-region className="flex-1" />
      <UpdateButton />
      <div className="flex h-full">
        <TitlebarButton label="Minimizar" onClick={windowControls.minimize}>
          <Minus {...ICON} />
        </TitlebarButton>
        <TitlebarButton label={maximized ? 'Restaurar' : 'Maximizar'} onClick={windowControls.toggleMaximize}>
          {maximized ? <Copy {...ICON} /> : <Square {...ICON} />}
        </TitlebarButton>
        <TitlebarButton label="Fechar" onClick={windowControls.close} danger>
          <X {...ICON} />
        </TitlebarButton>
      </div>
    </header>
  );
}

function TitlebarButton(props: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`flex w-11 items-center justify-center text-text-2 transition-colors duration-150 ${
        props.danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-bg-3 hover:text-text-1'
      }`}
    >
      {props.children}
    </button>
  );
}

function UpdateButton() {
  const { available, installing, error, install } = useUpdate();
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={() => void install()}
      disabled={installing}
      title={error ?? `Versão ${available.version}`}
      className="mr-2 flex h-6 items-center gap-1.5 rounded-sm bg-ok/15 px-2 text-meta font-semibold text-ok hover:bg-ok/25 disabled:opacity-60"
    >
      <Download size={13} strokeWidth={2} />
      {installing ? 'Atualizando…' : 'Atualizar e reiniciar'}
    </button>
  );
}
