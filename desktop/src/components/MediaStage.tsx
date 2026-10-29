import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Slider from '@radix-ui/react-slider';
import { Maximize2, MicOff, Monitor } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useCall } from '../media/call';
import type { RemoteMedia } from '../media/MediaSession';
import { useCommunity } from '../stores/community';
import { useSettings } from '../stores/settings';
import { useSpeaking } from '../stores/speaking';
import { useVoice } from '../stores/voice';
import { Avatar, cx } from './ui';

// One tile per participant (camera or avatar) plus one per screen share.
type Tile = { key: string; userId: string; kind: 'user' | 'screen'; media?: RemoteMedia; local?: MediaStreamTrack | null };

/** The call view (PLAN 8): 16:9 tiles, click to focus with a 96 px filmstrip, F for fullscreen. */
export function MediaStage() {
  const channelId = useVoice((s) => s.channelId);
  const me = useCommunity((s) => s.me?.id);
  const ids = useCommunity(
    useShallow((s) =>
      Object.values(s.voiceStates)
        .filter((v) => v.channel_id === channelId)
        .map((v) => v.user_id)
        .sort(),
    ),
  );
  const remote = useCall((s) => s.remote);
  const localCam = useCall((s) => s.localCam);
  const [focus, setFocus] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];
    for (const r of remote) if (r.kind === 'screen' && r.live) out.push({ key: r.id, userId: r.userId, kind: 'screen', media: r });
    for (const id of ids) {
      const cam = remote.find((r) => r.userId === id && r.kind === 'cam' && r.live);
      out.push({ key: 'u:' + id, userId: id, kind: 'user', media: cam, local: id === me ? localCam : undefined });
    }
    return out;
  }, [remote, ids, me, localCam]);

  const focused = tiles.find((t) => t.key === focus);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key.toLowerCase() !== 'f' || target.closest('input, textarea')) return;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void stage.current?.requestFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={stage} className="relative flex min-h-0 flex-1 flex-col bg-bg-0 p-4 pb-20">
      {focused ? (
        <>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <TileView tile={focused} big onClick={() => setFocus(null)} />
          </div>
          <div className="mt-3 flex h-24 shrink-0 justify-center gap-3 overflow-x-auto">
            {tiles
              .filter((t) => t.key !== focused.key)
              .map((t) => (
                <div key={t.key} className="aspect-video h-full shrink-0">
                  <TileView tile={t} onClick={() => setFocus(t.key)} />
                </div>
              ))}
          </div>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 content-center gap-3" style={{ gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(tiles.length || 1))}, minmax(0, 1fr))` }}>
          {tiles.map((t) => (
            <TileView key={t.key} tile={t} onClick={() => setFocus(t.key)} />
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label="Tela cheia (F)"
        title="Tela cheia (F)"
        onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void stage.current?.requestFullscreen())}
        className="absolute top-3 right-3 rounded-md p-2 text-text-2 hover:bg-bg-3 hover:text-text-1"
      >
        <Maximize2 size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

const TileView = memo(function TileView({ tile, big, onClick }: { tile: Tile; big?: boolean; onClick: () => void }) {
  const member = useCommunity((s) => s.members[tile.userId]);
  const state = useCommunity((s) => s.voiceStates[tile.userId]);
  const speaking = useSpeaking((s) => s.ids.has(tile.userId));
  const name = member?.display_name ?? '…';
  const video = tile.media || tile.local;
  const content = (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-bg-2 outline-2 outline-offset-2 transition-[outline-color] duration-150',
        big && 'max-h-full w-auto max-w-full',
        speaking && tile.kind === 'user' && !state?.self_mute ? 'outline outline-ok' : 'outline outline-transparent',
      )}
      style={big ? { height: '100%' } : undefined}
    >
      {video ? (
        <Video media={tile.media} local={tile.local ?? undefined} mirror={!!tile.local} />
      ) : (
        <Avatar id={tile.userId} name={name} url={member?.avatar_url} size={big ? 112 : 64} />
      )}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-sm bg-bg-0/80 px-2 py-0.5 text-meta text-text-1">
        {tile.kind === 'screen' && <Monitor size={12} strokeWidth={1.75} />}
        {name}
        {tile.kind === 'user' && state?.self_mute && <MicOff size={12} strokeWidth={1.75} className="text-danger" />}
      </span>
    </button>
  );
  if (tile.kind !== 'user' || tile.local !== undefined) return content;
  return <VolumeMenu userId={tile.userId}>{content}</VolumeMenu>;
});

function Video({ media, local, mirror }: { media?: RemoteMedia; local?: MediaStreamTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (media) {
      media.attach(el);
      return () => media.detach(el);
    }
    if (local) {
      el.srcObject = new MediaStream([local]);
      return () => void (el.srcObject = null);
    }
  }, [media, local]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cx('h-full w-full', media?.kind === 'screen' ? 'object-contain' : 'object-cover', mirror && '-scale-x-100')}
    />
  );
}

/** Right-click a participant: per-user volume (PLAN 7.4). */
export function VolumeMenu({ userId, children }: { userId: string; children: React.ReactNode }) {
  const volume = useSettings((s) => s.userVolumes[userId] ?? 1);
  const update = useSettings((s) => s.update);
  const set = (v: number) => update({ userVolumes: { ...useSettings.getState().userVolumes, [userId]: v } });
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 w-56 rounded-md border border-border bg-bg-1 p-3 shadow-popover">
          <div className="mb-2 flex justify-between text-meta text-text-2">
            <span>Volume do usuário</span>
            <span>{Math.round(volume * 100)} %</span>
          </div>
          <Slider.Root value={[volume * 100]} max={100} step={1} onValueChange={([v]) => set(v / 100)} className="relative flex h-5 items-center">
            <Slider.Track className="relative h-1 flex-1 rounded-full bg-bg-3">
              <Slider.Range className="absolute h-full rounded-full bg-accent" />
            </Slider.Track>
            <Slider.Thumb aria-label="Volume" className="block size-3.5 rounded-full bg-white" />
          </Slider.Root>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
