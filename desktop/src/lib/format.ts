// Formatting helpers (pt-BR).
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const full = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short' });

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Hoje às 14:32", "Ontem às 09:10" or "28/10/2026 14:32". */
export function messageTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `Hoje às ${time.format(d)}`;
  if (sameDay(d, yesterday)) return `Ontem às ${time.format(d)}`;
  return `${date.format(d)} ${time.format(d)}`;
}

export const shortTime = (iso: string) => time.format(new Date(iso));
export const fullTime = (iso: string) => full.format(new Date(iso));

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
}

/** Stable pastel-ish color per id, for avatars without a picture. */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 42%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
