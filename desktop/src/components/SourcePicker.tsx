import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AppWindow, Loader2, Monitor, X } from 'lucide-react';
import { useScreen } from '../media/ScreenShare';
import type { ContentMode, Preset, SourceRef } from '../shared/engine';
import { Button, IconButton, Toggle, cx } from './ui';

const presets: { id: Preset; label: string }[] = [
  { id: '720p30', label: '720p 30 fps' },
  { id: '1080p30', label: '1080p 30 fps' },
  { id: '1080p60', label: '1080p 60 fps' },
  { id: '1440p60', label: '1440p 60 fps' },
  { id: 'native60', label: 'Nativa 60 fps' },
];

/** Pick a monitor or window to share (PLAN 6.4, 6.7). */
export function SourcePicker() {
  const { pickerOpen, sources, closePicker, start } = useScreen();
  const [tab, setTab] = useState<'monitor' | 'window'>('monitor');
  const [sel, setSel] = useState<{ ref: SourceRef; label: string } | null>(null);
  const [preset, setPreset] = useState<Preset>('1080p60');
  const [content, setContent] = useState<ContentMode>('text');
  const [audio, setAudio] = useState(false);

  useEffect(() => {
    if (!sources || sel) return;
    const primary = sources.monitors.find((m) => m.primary) ?? sources.monitors[0];
    if (primary) setSel({ ref: { kind: 'monitor', id: primary.id }, label: primary.name });
  }, [sources, sel]);

  const items =
    tab === 'monitor'
      ? (sources?.monitors ?? []).map((m, i) => ({
          ref: { kind: 'monitor' as const, id: m.id },
          label: `Tela ${i + 1}${m.primary ? ' (principal)' : ''}`,
          sub: `${m.width}×${m.height}`,
          thumb: m.thumbnail,
        }))
      : (sources?.windows ?? []).map((w) => ({ ref: { kind: 'window' as const, id: w.id }, label: w.title, sub: w.process, thumb: w.thumbnail }));

  return (
    <Dialog.Root open={pickerOpen} onOpenChange={(o) => !o && closePicker()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(620px,88vh)] w-[min(820px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-2 shadow-popover">
          <div className="flex items-center gap-4 border-b border-border px-5 pt-4">
            <Dialog.Title className="pb-3 text-title font-semibold">Compartilhar tela</Dialog.Title>
            <div className="flex flex-1 gap-1">
              {(['monitor', 'window'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cx('border-b-2 px-3 pb-3 text-body', tab === t ? 'border-accent text-text-1' : 'border-transparent text-text-2 hover:text-text-1')}
                >
                  {t === 'monitor' ? 'Telas' : 'Janelas'}
                </button>
              ))}
            </div>
            <Dialog.Close asChild>
              <IconButton icon={X} label="Fechar" className="mb-3" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Escolha o que compartilhar</Dialog.Description>
          <div className="grid flex-1 auto-rows-min grid-cols-3 gap-3 overflow-y-auto p-5">
            {!sources && (
              <div className="col-span-3 flex justify-center py-16 text-text-3">
                <Loader2 size={22} className="animate-spin" />
              </div>
            )}
            {sources && items.length === 0 && <p className="col-span-3 py-16 text-center text-text-3">Nada para compartilhar aqui.</p>}
            {items.map((it) => {
              const active = sel?.ref.id === it.ref.id;
              return (
                <button
                  key={it.ref.id}
                  type="button"
                  onClick={() => setSel({ ref: it.ref, label: it.label })}
                  onDoubleClick={() => void start({ source: it.ref, label: it.label, preset, content_mode: content, system_audio: audio && it.ref.kind === 'monitor' })}
                  className={cx('rounded-md border-2 p-2 text-left transition-colors', active ? 'border-accent bg-bg-3' : 'border-transparent hover:bg-bg-3')}
                >
                  <div className="flex aspect-video items-center justify-center overflow-hidden rounded-sm bg-bg-0">
                    {it.thumb ? (
                      <img src={it.thumb} alt="" className="h-full w-full object-contain" draggable={false} />
                    ) : it.ref.kind === 'monitor' ? (
                      <Monitor size={28} strokeWidth={1.5} className="text-text-3" />
                    ) : (
                      <AppWindow size={28} strokeWidth={1.5} className="text-text-3" />
                    )}
                  </div>
                  <div className="mt-1.5 truncate text-body text-text-1">{it.label}</div>
                  <div className="truncate text-meta text-text-3">{it.sub}</div>
                </button>
              );
            })}
          </div>
          <div className="flex items-end gap-4 border-t border-border px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-meta font-semibold text-text-2">Qualidade</span>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
                className="h-9 rounded-md border border-border bg-bg-0 px-2 text-body text-text-1 outline-none focus:border-accent"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-1 block text-meta font-semibold text-text-2">Priorizar</span>
              <div className="flex h-9 overflow-hidden rounded-md border border-border">
                {(['text', 'motion'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setContent(m)}
                    className={cx('px-3 text-body', content === m ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:text-text-1')}
                    title={m === 'text' ? 'Mantém a resolução; sob rede fraca reduz o fps' : 'Mantém 60 fps; sob rede fraca reduz a resolução'}
                  >
                    {m === 'text' ? 'Nitidez' : 'Fluidez'}
                  </button>
                ))}
              </div>
            </div>
            <div className="w-48">
              {sel?.ref.kind === 'monitor' && <Toggle label="Áudio do sistema" checked={audio} onChange={setAudio} />}
            </div>
            <div className="flex-1" />
            <Button
              disabled={!sel}
              onClick={() => sel && void start({ source: sel.ref, label: sel.label, preset, content_mode: content, system_audio: audio && sel.ref.kind === 'monitor' })}
            >
              Compartilhar
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
