// Window-wide notices: the update strip under the titlebar and the toasts.
import { CheckCircle2, Download, Info, RotateCw, XCircle } from 'lucide-react';
import { useUpdate } from '../app/updates';
import { useToasts, type ToastTone } from '../stores/toast';
import { cx } from './ui';

/** Download progress and the restart countdown of a forced update (PLAN fase 9A). */
export function UpdateBanner() {
  const { phase, version, percent, countdown } = useUpdate();
  if (phase !== 'downloading' && phase !== 'restarting') return null;
  return (
    <div
      role="status"
      className="relative flex h-7 shrink-0 animate-[slide-down_180ms_ease-out] items-center justify-center gap-2 overflow-hidden bg-accent/12 text-meta font-medium text-accent"
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-full origin-left bg-accent/15 transition-transform duration-300 ease-out"
        style={{ transform: `scaleX(${phase === 'restarting' ? 1 : (percent ?? 0) / 100})` }}
      />
      {phase === 'downloading' ? (
        <>
          <Download size={14} strokeWidth={2} className="relative" />
          <span className="relative">
            Nova versão {version}
            {percent !== null && <span className="text-accent/70"> · {percent}%</span>}
          </span>
        </>
      ) : (
        <>
          <RotateCw size={14} strokeWidth={2} className="relative animate-spin [animation-duration:1.6s]" />
          <span className="relative">Reiniciando em {countdown}…</span>
        </>
      )}
    </div>
  );
}

const toneIcon = { info: Info, ok: CheckCircle2, danger: XCircle } satisfies Record<ToastTone, unknown>;
const toneColor: Record<ToastTone, string> = { info: 'text-accent', ok: 'text-ok', danger: 'text-danger' };

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div aria-live="polite" className="pointer-events-none fixed top-12 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => {
        const Icon = toneIcon[t.tone];
        return (
          <div
            key={t.id}
            className="flex animate-[pop_180ms_ease-out] items-center gap-2 rounded-full border border-border bg-bg-1 py-2 pr-4 pl-3 text-body text-text-1 shadow-popover"
          >
            <Icon size={16} strokeWidth={2} className={cx('shrink-0', toneColor[t.tone])} />
            {t.text}
          </div>
        );
      })}
    </div>
  );
}
