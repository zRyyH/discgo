import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy, FileText, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/rest';
import { fileSize, fullTime, messageTime, shortTime } from '../lib/format';
import type { Attachment, Message } from '../shared/protocol';
import { openExternal } from '../shared/shell';
import { useCommunity } from '../stores/community';
import { useMessages } from '../stores/messages';
import { useUi } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { Avatar, EmptyState, IconButton, Tip, cx } from './ui';

// Messages from the same author within 5 minutes are grouped under one header.
const GROUP_MS = 5 * 60 * 1000;
const LOAD_OLDER_PX = 400;
const STICK_PX = 48;

type Row = { kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; message: Message; head: boolean };

const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

// Messages that just arrived slide in once; history and rows scrolling back in do not.
const FRESH_MS = 5_000;
const animated = new Set<string>();
function arrivesNow(m: Message) {
  if (animated.has(m.id) || Date.now() - new Date(m.created_at).getTime() > FRESH_MS) return false;
  animated.add(m.id);
  return true;
}

function buildRows(items: Message[]): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  for (const m of items) {
    const t = new Date(m.created_at);
    const pt = prev ? new Date(prev.created_at) : undefined;
    const newDay = !pt || t.toDateString() !== pt.toDateString();
    if (newDay) rows.push({ kind: 'day', key: 'day-' + m.id, label: dayFmt.format(t) });
    const head = newDay || !prev || prev.author_id !== m.author_id || t.getTime() - pt!.getTime() > GROUP_MS;
    rows.push({ kind: 'msg', key: m.id, message: m, head });
    prev = m;
  }
  return rows;
}

export function MessageList({ channelId }: { channelId: string }) {
  const history = useMessages((s) => s.byChannel[channelId]);
  const load = useMessages((s) => s.load);
  const loadOlder = useMessages((s) => s.loadOlder);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rows = useMemo(() => buildRows(history?.items ?? []), [history?.items]);

  useEffect(() => {
    if (!history?.loaded && !history?.loading && !history?.error) void load(channelId);
  }, [channelId, history?.loaded, history?.loading, history?.error, load]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === 'day' ? 40 : (rows[i] as { head: boolean }).head ? 66 : 26),
    getItemKey: (i) => rows[i].key,
    overscan: 12,
  });

  // Keep the view anchored: at the bottom for new messages, in place when older ones are prepended.
  const firstKey = rows[0]?.key;
  const lastKey = rows[rows.length - 1]?.key;
  const prev = useRef({ firstKey, lastKey, fromBottom: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const p = prev.current;
    if (p.firstKey !== firstKey && p.lastKey === lastKey && p.firstKey) {
      el.scrollTop = el.scrollHeight - p.fromBottom;
    } else if (stick.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    }
    prev.current = { firstKey, lastKey, fromBottom: el.scrollHeight - el.scrollTop };
  }, [firstKey, lastKey, rows.length, virtualizer]);

  useEffect(() => {
    stick.current = true;
  }, [channelId]);

  const onScroll = () => {
    const el = scrollRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    prev.current.fromBottom = el.scrollHeight - el.scrollTop;
    if (el.scrollTop < LOAD_OLDER_PX) void loadOlder(channelId);
  };

  if (history?.loaded && rows.length === 0) {
    return <EmptyState icon={MessageSquare} text="Nenhuma mensagem ainda. Diga oi!" />;
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} data-message-scroller className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ contain: 'strict' }}>
      {!history?.loaded && <SkeletonRows />}
      {history?.error && <p className="p-4 text-meta text-danger">{history.error}</p>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {row.kind === 'day' ? <DayDivider label={row.label} /> : <MessageRow message={row.message} head={row.head} />}
            </div>
          );
        })}
      </div>
      <div className="h-4" />
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="mx-4 flex items-center gap-3 py-3 text-meta text-text-3">
      <div className="h-px flex-1 bg-border/60" />
      <span className="rounded-full border border-border/60 px-2.5 py-0.5">{label}</span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-5 p-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="size-10 rounded-full bg-bg-3" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-32 rounded-sm bg-bg-3" />
            <div className="h-3 rounded-sm bg-bg-3" style={{ width: `${70 - i * 12}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, head }: { message: Message; head: boolean }) {
  const author = useCommunity((s) => s.members[message.author_id]);
  const mine = useCommunity((s) => s.me?.id === message.author_id);
  const editing = useUi((s) => s.editingId === message.id);
  const setEditing = useUi((s) => s.setEditing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fresh] = useState(() => arrivesNow(message));
  const name = author?.display_name ?? 'Usuário removido';

  const remove = () => void api.deleteMessage(message.id).catch(() => {});

  return (
    <div
      className={cx(
        'group relative flex gap-3 px-4 transition-colors duration-100 hover:bg-bg-1/60',
        head ? 'mt-3 pt-1 pb-0.5' : 'py-0.5',
        fresh && 'animate-[rise_200ms_ease-out]',
      )}
    >
      <div className="w-10 shrink-0">
        {head ? (
          <Avatar id={message.author_id} name={name} url={author?.avatar_url} size={40} />
        ) : (
          <Tip label={fullTime(message.created_at)}>
            <span className="invisible block pt-0.5 text-right text-[11px] text-text-3 group-hover:visible">
              {shortTime(message.created_at)}
            </span>
          </Tip>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {head && (
          <div className="flex items-baseline gap-2">
            <span className="text-msg font-semibold text-text-1">{name}</span>
            <Tip label={fullTime(message.created_at)}>
              <span className="text-meta text-text-3">{messageTime(message.created_at)}</span>
            </Tip>
          </div>
        )}
        {editing ? (
          <EditBox message={message} onDone={() => setEditing(null)} />
        ) : (
          message.content && (
            <p className="text-msg break-words whitespace-pre-wrap text-text-1 select-text">
              <Linkified text={message.content} />
              {message.edited_at && (
                <Tip label={fullTime(message.edited_at)}>
                  <span className="ml-1 text-[11px] text-text-3">(editada)</span>
                </Tip>
              )}
            </p>
          )
        )}
        {message.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <AttachmentView key={a.key} attachment={a} />
            ))}
          </div>
        )}
      </div>
      {!editing && (
        <div className="pointer-events-none absolute -top-3 right-4 flex translate-y-1 rounded-md border border-border bg-bg-2 opacity-0 shadow-popover transition-[opacity,translate] duration-150 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
          {message.content && (
            <IconButton icon={Copy} label="Copiar texto" size={16} onClick={() => void navigator.clipboard.writeText(message.content)} />
          )}
          {mine && <IconButton icon={Pencil} label="Editar" size={16} onClick={() => setEditing(message.id)} />}
          {mine && <IconButton icon={Trash2} label="Apagar" size={16} danger onClick={() => setConfirmDelete(true)} />}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Apagar mensagem"
        text="A mensagem será apagada para todos."
        confirm="Apagar"
        onConfirm={remove}
      />
    </div>
  );
});

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const [value, setValue] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = async () => {
    const content = value.trim();
    if (content && content !== message.content) await api.editMessage(message.id, content).catch(() => {});
    onDone();
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(8, value.split('\n').length)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
        className="w-full resize-none rounded-md border border-border bg-bg-3 px-3 py-2 text-msg text-text-1 outline-none focus:border-accent"
      />
      <p className="text-meta text-text-3">Esc cancela · Enter salva</p>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={p}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(p);
            }}
            className="text-accent hover:underline"
          >
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function AttachmentView({ attachment: a }: { attachment: Attachment }) {
  if (a.content_type.startsWith('image/') && a.url) {
    // Known dimensions reserve the space before the image loads (no layout jump).
    const w = a.width ?? 320;
    const h = a.height ?? 200;
    const scale = Math.min(1, 400 / w, 300 / h);
    return (
      <button type="button" onClick={() => void openExternal(a.url!)} className="block overflow-hidden rounded-md bg-bg-3 transition-opacity duration-150 hover:opacity-90">
        <img src={a.url} alt={a.name} loading="lazy" width={Math.round(w * scale)} height={Math.round(h * scale)} className="block object-cover" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => a.url && void openExternal(a.url)}
      className="flex w-72 items-center gap-3 rounded-md border border-border bg-bg-1 px-3 py-2 text-left transition-colors duration-150 hover:bg-bg-3"
    >
      <FileText size={28} strokeWidth={1.5} className="shrink-0 text-accent" />
      <span className="min-w-0">
        <span className="block truncate text-body text-text-1">{a.name}</span>
        <span className="text-meta text-text-3">{fileSize(a.size)}</span>
      </span>
    </button>
  );
}
