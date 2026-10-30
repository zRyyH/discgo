// Small shared building blocks styled with the design tokens (desktop/DESIGN.md).
import * as Switch from '@radix-ui/react-switch';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { colorFor, initials } from '../lib/format';

export const ICON = { size: 18, strokeWidth: 1.75 } as const;

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

// Radix dialogs: the overlay fades, the panel pops; both play back out on close.
export const dialogOverlay =
  'fixed inset-0 z-40 bg-bg-0/75 data-[state=open]:animate-[fade-in_150ms_ease-out] data-[state=closed]:animate-[fade-out_120ms_ease-in]';
export const dialogPanel =
  'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 border border-border bg-bg-2 shadow-popover data-[state=open]:animate-[pop_180ms_ease-out] data-[state=closed]:animate-[pop-out_120ms_ease-in]';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-body font-semibold transition duration-150 enabled:active:scale-[0.97] disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-bg-0 hover:brightness-110',
        variant === 'ghost' && 'bg-bg-3 text-text-1 hover:bg-border',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        className,
      )}
      {...rest}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-9 w-full rounded-md border border-border bg-bg-0 px-3 text-body text-text-1 outline-none transition-colors placeholder:text-text-3 focus:border-accent',
        className,
      )}
      {...rest}
    />
  );
});

/** Icon-only button with a tooltip. `danger` + `active` is a toggled-off state (muted, deafened). */
export function IconButton(props: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
  size?: number;
  className?: string;
  disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <Tip label={props.label}>
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.active}
        disabled={props.disabled}
        onClick={props.onClick}
        className={cx(
          'flex size-8 items-center justify-center rounded-md transition duration-150 enabled:active:scale-90 disabled:opacity-40',
          props.danger ? 'text-danger hover:bg-danger/15' : 'text-text-2 hover:bg-bg-3 hover:text-text-1',
          props.active && (props.danger ? 'bg-danger/15' : 'bg-bg-3 text-text-1'),
          props.className,
        )}
      >
        <SwapIcon icon={Icon} size={props.size ?? ICON.size} />
      </button>
    </Tip>
  );
}

/** Pops when the icon changes (mic → mic off), not when it first mounts (rows scrolling in). */
function SwapIcon({ icon: Icon, size }: { icon: LucideIcon; size: number }) {
  const [swaps, setSwaps] = useState(0);
  const prev = useRef(Icon);
  useEffect(() => {
    if (prev.current === Icon) return;
    prev.current = Icon;
    setSwaps((n) => n + 1);
  }, [Icon]);
  return <Icon key={swaps} size={size} strokeWidth={ICON.strokeWidth} className={swaps ? 'animate-[pop_160ms_ease-out]' : undefined} />;
}

export function Tip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root delayDuration={400}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-sm bg-bg-0 px-2 py-1 text-meta text-text-1 shadow-popover data-[state=delayed-open]:animate-[pop_120ms_ease-out] data-[state=instant-open]:animate-[fade-in_80ms_ease-out]"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * The Google account photo; initials on a colour from the id when there is none or it fails to load.
 * `ring`: the speaking ring (undefined: no ring at all), fading in and out.
 */
export function Avatar({ id, name, url, size = 32, ring }: { id: string; name: string; url?: string; size?: number; ring?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.38) };
  const ringCls =
    ring === undefined ? '' : cx('outline-2 outline-offset-1 transition-[outline-color] duration-150', ring ? 'outline outline-ok' : 'outline outline-transparent');
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setFailed(url)}
        className={cx('shrink-0 rounded-full bg-bg-3 object-cover', ringCls)}
        style={style}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cx('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', ringCls)}
      style={{ ...style, background: colorFor(id) }}
    >
      {initials(name)}
    </div>
  );
}

/** The DiscGo mark (src-tauri/icon.svg): accent ring, green dot. `breathe` pulses the dot (connecting). */
export function BrandMark({ size = 56, breathe }: { size?: number; breathe?: boolean }) {
  const ring = Math.round(size * 0.5);
  const dot = Math.max(4, Math.round(size * 0.16));
  return (
    <div
      className="relative flex shrink-0 items-center justify-center border border-border bg-bg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
    >
      <div className="rounded-full border-accent" style={{ width: ring, height: ring, borderWidth: Math.max(2, Math.round(size * 0.09)) }} />
      <span
        className={cx('absolute rounded-full bg-ok', breathe && 'animate-[breathe_1.6s_ease-in-out_infinite]')}
        style={{ width: dot, height: dot }}
      />
    </div>
  );
}

/** Two soft glows and a faded dot grid behind full-window states; static after the first paint. */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-56 -left-48 size-[720px] rounded-full bg-[radial-gradient(closest-side,rgba(139,156,255,0.16),transparent)]" />
      <div className="absolute -right-40 -bottom-64 size-[640px] rounded-full bg-[radial-gradient(closest-side,rgba(61,220,151,0.08),transparent)]" />
      <div className="absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)] bg-[radial-gradient(rgba(231,233,240,0.07)_1px,transparent_1px)] [background-size:22px_22px]" />
    </div>
  );
}

/** Full-window wait (starting, connecting): the backdrop and the mark breathing, one line. */
export function Splash({ text }: { text: string }) {
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-bg-0">
      <Backdrop />
      <div className="relative flex animate-[fade-in_300ms_ease-out] flex-col items-center gap-4">
        <BrandMark size={64} breathe />
        <p className="text-body text-text-2">{text}</p>
      </div>
    </div>
  );
}

/** The sign-in screen's card, for panels inside the app. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-lg border border-border bg-bg-1 p-5', className)} {...rest} />;
}

/** One icon on a raised tile and one line; optionally one action. */
export function EmptyState({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[280px] animate-[rise_220ms_ease-out] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-bg-3 text-text-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <Icon size={24} strokeWidth={1.75} />
      </div>
      <p className="text-body text-text-2">{text}</p>
      {action}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-2 text-body">
      {label}
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-bg-3 transition-colors duration-150 data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </label>
  );
}

/**
 * A row of mutually exclusive options with a pill that slides to the chosen one.
 * The pill is the one place that transitions `width`: it is absolutely positioned,
 * so nothing else lays out again.
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: { id: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const buttons = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = buttons.current[props.value];
    if (!el) return;
    const next = { x: el.offsetLeft, w: el.offsetWidth };
    if (next.x !== pill?.x || next.w !== pill?.w) setPill(next);
  });
  return (
    <div role="tablist" className={cx('relative flex rounded-md bg-bg-0/70 p-0.5', props.className)}>
      {pill && (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 left-0 rounded-[7px] bg-bg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-[translate,width] duration-200 ease-out"
          style={{ translate: `${pill.x}px 0`, width: pill.w }}
        />
      )}
      {props.options.map((o) => (
        <button
          key={o.id}
          ref={(el) => {
            buttons.current[o.id] = el;
          }}
          type="button"
          role="tab"
          aria-selected={props.value === o.id}
          title={o.title}
          onClick={() => props.onChange(o.id)}
          className={cx(
            'relative flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-body font-medium transition-colors duration-150',
            props.value === o.id ? 'text-text-1' : 'text-text-2 hover:text-text-1',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Keeps something mounted for `ms` after `show` turns false, so it can play a leave
 * animation: `leaving` is true during that time.
 */
export function usePresence(show: boolean, ms = 160) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [show, ms]);
  return { mounted: show || mounted, leaving: !show && mounted };
}
