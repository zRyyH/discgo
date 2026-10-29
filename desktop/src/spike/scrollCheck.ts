// Phase 4 check (PLAN 10): scroll a channel with all of its history loaded and
// record frame times and long animation frames. Dev only: `?spike=scroll&channel=<id>`.
import { useCommunity } from '../stores/community';
import { useMessages } from '../stores/messages';
import { useUi } from '../stores/ui';

const HARNESS = 'http://127.0.0.1:8090/report';
const STEP_PX = 80;

const report = (data: Record<string, unknown>) =>
  void fetch(HARNESS, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ check: 'scroll', ...data }) });

const until = async (cond: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

export async function runScrollCheck(channelId: string) {
  await until(() => useCommunity.getState().ready);
  useUi.getState().selectChannel(channelId);
  await until(() => useMessages.getState().byChannel[channelId]?.loaded === true);
  const t0 = performance.now();
  for (;;) {
    const h = useMessages.getState().byChannel[channelId];
    if (!h?.hasMore) break;
    await useMessages.getState().loadOlder(channelId);
  }
  const count = useMessages.getState().byChannel[channelId]?.items.length;
  report({ step: 'loaded', messages: count, ms: Math.round(performance.now() - t0) });

  const el = document.querySelector<HTMLElement>('[data-message-scroller]')!;
  await new Promise((r) => setTimeout(r, 500));
  el.scrollTop = el.scrollHeight;
  for (let i = 0; i < 10; i++) await frame();

  const loaf: number[] = [];
  const obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => loaf.push(e.duration)));
  try {
    obs.observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    /* not supported */
  }

  const deltas: number[] = [];
  let last = await frame();
  const run = async (dir: -1 | 1) => {
    for (;;) {
      const before = el.scrollTop;
      el.scrollTop = before + dir * STEP_PX;
      const now = await frame();
      deltas.push(now - last);
      last = now;
      if (el.scrollTop === before) break; // reached the end
    }
  };
  await run(-1);
  await run(1);
  obs.disconnect();

  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
  report({
    step: 'scrolled',
    frames: deltas.length,
    frame_p50_ms: pct(0.5),
    frame_p95_ms: pct(0.95),
    frame_max_ms: +sorted[sorted.length - 1].toFixed(1),
    // A delta above ~1.5 frames at 60 Hz means a frame was missed.
    missed_frames: deltas.filter((d) => d > 25).length,
    missed_at: deltas.flatMap((d, i) => (d > 25 ? [`${i}:${Math.round(d)}ms`] : [])).join(" "),
    long_animation_frames: loaf.length,
    loaf_max_ms: loaf.length ? Math.round(Math.max(...loaf)) : 0,
  });
}
