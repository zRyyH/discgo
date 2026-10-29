import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, SendHorizontal, X } from 'lucide-react';
import { api, ApiError, uploadFile } from '../api/rest';
import { fileSize } from '../lib/format';
import type { Attachment } from '../shared/protocol';
import { useCommunity } from '../stores/community';
import { useMessages } from '../stores/messages';
import { useUi } from '../stores/ui';
import { IconButton, cx } from './ui';

interface Pending {
  id: number;
  file: File;
  progress: number;
  attachment?: Attachment;
  error?: string;
  abort: AbortController;
}

let nextId = 1;

async function imageSize(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith('image/')) return {};
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return {};
  }
}

export function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const upsert = useMessages((s) => s.upsert);
  const setEditing = useUi((s) => s.setEditing);

  useEffect(() => {
    ref.current?.focus();
    setText('');
    setError(null);
    setPending((p) => {
      p.forEach((x) => x.abort.abort());
      return [];
    });
  }, [channelId]);

  // Auto-grow up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [text]);

  const update = (id: number, patch: Partial<Pending>) =>
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files).slice(0, 10)) {
      const p: Pending = { id: nextId++, file, progress: 0, abort: new AbortController() };
      setPending((list) => [...list, p]);
      void (async () => {
        try {
          const type = file.type || 'application/octet-stream';
          const [{ key, url, headers }, dims] = await Promise.all([api.presign(file.name, type, file.size), imageSize(file)]);
          await uploadFile(url, file, headers, (progress) => update(p.id, { progress }), p.abort.signal);
          update(p.id, { progress: 1, attachment: { key, name: file.name, content_type: type, size: file.size, ...dims } });
        } catch (e) {
          if (!p.abort.signal.aborted) update(p.id, { error: e instanceof ApiError ? e.message : 'Falha no envio.' });
        }
      })();
    }
  };

  const uploading = pending.some((p) => !p.attachment && !p.error);
  const ready = pending.filter((p) => p.attachment).map((p) => p.attachment!);

  const send = async () => {
    const content = text.trim();
    if (sending || uploading || (!content && ready.length === 0)) return;
    setSending(true);
    setError(null);
    try {
      const m = await api.sendMessage(channelId, content, ready);
      upsert(m);
      setText('');
      setPending([]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível enviar.');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const editLast = () => {
    const me = useCommunity.getState().me?.id;
    const items = useMessages.getState().byChannel[channelId]?.items ?? [];
    const last = [...items].reverse().find((m) => m.author_id === me && m.content);
    if (last) setEditing(last.id);
  };

  return (
    <div
      className="shrink-0 px-4 pb-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div key={p.id} className="relative flex w-56 items-center gap-2 overflow-hidden rounded-md border border-border bg-bg-1 px-3 py-2">
              <FileText size={20} strokeWidth={1.5} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body">{p.file.name}</div>
                <div className={cx('text-meta', p.error ? 'text-danger' : 'text-text-3')}>
                  {p.error ?? (p.attachment ? fileSize(p.file.size) : `${Math.round(p.progress * 100)} %`)}
                </div>
              </div>
              <IconButton
                icon={X}
                label="Remover"
                size={14}
                className="size-6"
                onClick={() => {
                  p.abort.abort();
                  setPending((list) => list.filter((x) => x.id !== p.id));
                }}
              />
              {!p.attachment && !p.error && (
                <div className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-150" style={{ width: `${p.progress * 100}%` }} />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1 rounded-lg border border-border bg-bg-3 px-2 py-1.5 transition-colors focus-within:border-accent">
        <IconButton icon={Plus} label="Anexar arquivo" onClick={() => fileInput.current?.click()} />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={`Conversar em #${channelName}`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === 'ArrowUp' && text === '') {
              e.preventDefault();
              editLast();
            }
          }}
          className="max-h-[220px] min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-msg text-text-1 outline-none placeholder:text-text-3"
        />
        <IconButton
          icon={SendHorizontal}
          label={uploading ? 'Aguardando envio dos anexos' : 'Enviar'}
          disabled={sending || uploading || (!text.trim() && ready.length === 0)}
          onClick={() => void send()}
        />
      </div>
      {error && <p className="mt-1 text-meta text-danger">{error}</p>}
    </div>
  );
}
