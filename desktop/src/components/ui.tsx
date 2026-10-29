// Small shared building blocks styled with the design tokens (desktop/DESIGN.md).
import * as Switch from '@radix-ui/react-switch';
import * as Tooltip from '@radix-ui/react-tooltip';
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { colorFor, initials } from '../lib/format';

export const ICON = { size: 18, strokeWidth: 1.75 } as const;

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

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
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-body font-semibold transition-colors duration-150 disabled:opacity-50',
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

/** Icon-only button with a tooltip. */
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
          'flex size-8 items-center justify-center rounded-md transition-colors duration-150 disabled:opacity-40',
          props.danger ? 'text-danger hover:bg-danger/15' : 'text-text-2 hover:bg-bg-3 hover:text-text-1',
          props.active && 'bg-bg-3 text-text-1',
          props.className,
        )}
      >
        <Icon size={props.size ?? ICON.size} strokeWidth={ICON.strokeWidth} />
      </button>
    </Tip>
  );
}

export function Tip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root delayDuration={400}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-sm bg-bg-0 px-2 py-1 text-meta text-text-1 shadow-popover data-[state=delayed-open]:animate-[fade-in_120ms_ease-out]"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The Google account photo; initials on a colour from the id when there is none or it fails to load. */
export function Avatar({ id, name, url, size = 32, ring }: { id: string; name: string; url?: string; size?: number; ring?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.38) };
  const ringCls = ring ? 'outline outline-2 outline-offset-1 outline-ok' : '';
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

export function EmptyState({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-3">
      <Icon size={28} strokeWidth={1.5} />
      <p className="text-body">{text}</p>
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
        className="relative h-5 w-9 shrink-0 rounded-full bg-bg-3 transition-colors data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </label>
  );
}
