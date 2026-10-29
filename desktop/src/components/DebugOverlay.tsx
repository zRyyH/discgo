import { useEffect, useState } from 'react';
import { useCall } from '../media/call';
import { useCommunity } from '../stores/community';
import { useUi } from '../stores/ui';

interface VideoStats {
  id: string;
  who: string;
  kind: string;
  res: string;
  fps: number | null;
  jitterMs: number | null;
  dropped: number | null;
  decoder: string;
}

/** Ctrl+Shift+D (PLAN 6.9): transport and receiver stats, polled at 1 Hz only while open. */
export function DebugOverlay() {
  const open = useUi((s) => s.debugOpen);
  const toggle = useUi((s) => s.toggleDebug);
  const call = useCall();
  const members = useCommunity((s) => s.members);
  const [videos, setVideos] = useState<VideoStats[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  useEffect(() => {
    if (!open) return;
    const prev = new Map<string, { frames: number; t: number }>();
    const tick = async () => {
      const out: VideoStats[] = [];
      for (const r of useCall.getState().remote) {
        if (!r.receiver || r.track.kind !== 'video') continue;
        const report = await r.receiver.getStats().catch(() => null);
        report?.forEach((s) => {
          if (s.type !== 'inbound-rtp') return;
          const p = prev.get(r.id);
          const fps = p ? ((s.framesDecoded - p.frames) * 1000) / (s.timestamp - p.t) : null;
          prev.set(r.id, { frames: s.framesDecoded, t: s.timestamp });
          out.push({
            id: r.id,
            who: members[r.userId]?.display_name ?? r.userId.slice(-4),
            kind: r.kind,
            res: s.frameWidth ? `${s.frameWidth}×${s.frameHeight}` : '—',
            fps: fps != null ? Math.round(fps) : null,
            jitterMs: s.jitterBufferEmittedCount ? Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000) : null,
            dropped: s.framesDropped ?? null,
            decoder: s.decoderImplementation ?? '',
          });
        });
      }
      setVideos(out);
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => clearInterval(t);
  }, [open, members]);

  if (!open) return null;
  const s = call.stats;
  const rows: [string, string | number | null | undefined][] = [
    ['modo', call.mode],
    ['estado', call.state],
    ['sessão', call.sessionId?.slice(-8)],
    ['conectou em', call.connectedAt && call.sessionAt ? `${Math.round(call.connectedAt - call.sessionAt)} ms` : null],
    ['rtt', s?.rttMs != null ? `${s.rttMs} ms` : null],
    ['caminho', s?.candidate],
    ['saída / entrada', s ? `${s.outKbps ?? '—'} / ${s.inKbps ?? '—'} kbit/s` : null],
    ['jitter buffer (voz)', s?.audioJitterMs != null ? `${s.audioJitterMs} ms` : null],
    ['perda (voz)', s?.audioLoss != null ? `${(s.audioLoss * 100).toFixed(1)} %` : null],
  ];
  return (
    <div className="fixed right-3 bottom-3 z-50 w-80 rounded-md border border-border bg-bg-0/95 p-3 font-mono text-[11px] leading-5 text-text-2 shadow-popover">
      <div className="mb-1 flex justify-between text-text-1">
        <span>debug</span>
        <span className="text-text-3">Ctrl+Shift+D</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <span className="text-text-3">{k}</span>
          <span className="truncate text-text-1">{v ?? '—'}</span>
        </div>
      ))}
      {videos.map((v) => (
        <div key={v.id} className="mt-2 border-t border-border pt-1">
          <div className="text-text-1">
            {v.who} · {v.kind}
          </div>
          <div>
            {v.res} @ {v.fps ?? '—'} fps · jb {v.jitterMs ?? '—'} ms · drop {v.dropped ?? '—'}
          </div>
          <div className="truncate text-text-3">{v.decoder}</div>
        </div>
      ))}
    </div>
  );
}
