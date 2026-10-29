// Engine ⇄ shell protocol (PLAN 6.8). Mirror of engine/src/protocol.rs — keep both in sync.
// One JSON object per line: commands on the engine's stdin, events on its stdout.

export type Preset = '720p30' | '1080p30' | '1080p60' | '1440p60' | 'native60';
export type ContentMode = 'text' | 'motion';
export type Codec = 'h264' | 'av1';
export type SdpKind = 'offer' | 'answer';
export type Vendor = 'nvidia' | 'amd' | 'intel' | 'microsoft' | 'software';

export type EngineTarget =
  | { kind: 'livekit'; url: string; token: string }
  | { kind: 'p2p'; session_id: string; stun_server?: string };

export type SourceRef = { kind: 'monitor'; id: string } | { kind: 'window'; id: string };

export interface StartParams {
  target: EngineTarget;
  source: SourceRef;
  preset?: Preset;
  codec?: Codec;
  content_mode?: ContentMode;
  system_audio?: boolean;
}

export type EngineCommand =
  | { cmd: 'probe'; force?: boolean }
  | { cmd: 'list_sources'; thumbnails?: boolean }
  | ({ cmd: 'start' } & StartParams)
  | { cmd: 'update'; preset?: Preset; content_mode?: ContentMode }
  | { cmd: 'sdp'; session_id: string; type: SdpKind; sdp: string }
  | { cmd: 'ice'; session_id: string; candidate: string; sdp_mid: string | null; sdp_m_line_index: number }
  | { cmd: 'stop' }
  | { cmd: 'shutdown' };

export interface AdapterInfo {
  index: number;
  luid: number;
  description: string;
  vendor_id: number;
  device_id: number;
}

export interface EncoderInfo {
  name: string;
  vendor: Vendor;
  codec: Codec;
  hardware: boolean;
  d3d11: boolean;
  adapter: AdapterInfo | null;
}

export interface MonitorInfo {
  id: string;
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  adapter: number | null;
  thumbnail?: string;
}

export interface WindowInfo {
  id: string;
  title: string;
  process: string;
  width: number;
  height: number;
  thumbnail?: string;
}

export interface EngineStats {
  fps_captured: number;
  fps_encoded: number;
  bitrate_kbps: number;
  target_kbps: number;
  encode_ms_p50: number;
  encode_ms_p99: number;
  dropped: number;
  width: number;
  height: number;
  fps_limit: number;
  rtt_ms: number | null;
  loss: number | null;
}

export type EngineEvent =
  | { event: 'ready'; gst_version: string; encoders: EncoderInfo[]; warnings: string[] }
  | { event: 'sources'; monitors: MonitorInfo[]; windows: WindowInfo[] }
  | {
      event: 'started';
      encoder: string;
      adapter: AdapterInfo | null;
      zero_copy: boolean;
      codec: Codec;
      width: number;
      height: number;
      fps: number;
    }
  | { event: 'sdp'; session_id: string; type: SdpKind; sdp: string }
  | { event: 'ice'; session_id: string; candidate: string; sdp_mid: string | null; sdp_m_line_index: number }
  | ({ event: 'stats' } & EngineStats)
  | { event: 'stopped' }
  | { event: 'error'; code: string; message: string; fatal: boolean };
