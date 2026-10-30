// One-line notices at the bottom of the window; they go away on their own.
import { create } from 'zustand';

export type ToastTone = 'info' | 'ok' | 'danger';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

const SHOW_MS = 3500;
const MAX = 3;

export const useToasts = create<{ items: Toast[] }>()(() => ({ items: [] }));

let nextId = 1;

export function toast(text: string, tone: ToastTone = 'info') {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items, { id, text, tone }].slice(-MAX) }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), SHOW_MS);
}
