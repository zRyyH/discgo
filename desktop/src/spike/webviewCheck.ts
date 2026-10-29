// Phase 1 spike (PLAN 2.1): checks the three WebView2 risks from inside the app
// window. Loaded only in dev with `?spike=webview`; reports one JSON line per
// second to the spike harness (engine/spike/serve.mjs).
const HARNESS = 'http://127.0.0.1:8090/report';

function report(data: Record<string, unknown>) {
  void fetch(HARNESS, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ check: 'webview', ...data }) });
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

export async function runWebviewCheck() {
  report({ step: 'boot', user_agent: navigator.userAgent });

  // 1. Media permission: must resolve without a prompt (a prompt would hang until timeout).
  const devices = await navigator.mediaDevices.enumerateDevices();
  const hasCamera = devices.some((d) => d.kind === 'videoinput');
  report({ step: 'devices', kinds: devices.map((d) => d.kind) });
  const t0 = performance.now();
  const stream = await within(
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
      video: hasCamera ? { width: 1280, height: 720, frameRate: 30 } : false,
    }),
    8000,
  ).catch((e: Error) => e);
  if (!(stream instanceof MediaStream)) {
    report({ step: 'getUserMedia', ok: false, result: String(stream) });
    return;
  }
  report({ step: 'getUserMedia', ok: true, ms: Math.round(performance.now() - t0), tracks: stream.getTracks().map((t) => t.kind) });

  // 2. Loopback call: keeps encoding/decoding so throttling would show up as missing frames.
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  stream.getTracks().forEach((t) => a.addTrack(t, stream));
  if (!hasCamera) {
    // No webcam on this machine: a canvas stream stands in so video keeps flowing.
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const g = canvas.getContext('2d')!;
    setInterval(() => {
      g.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`;
      g.fillRect(0, 0, 640, 360);
    }, 33);
    canvas.captureStream(30).getTracks().forEach((t) => a.addTrack(t, stream));
  }
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription!);

  // 3. Throttling: a 50 ms interval and the decoded frame rate, sampled every second.
  let last = performance.now();
  let maxGap = 0;
  setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 50);
  let prev = { frames: 0, audio: 0 };
  setInterval(async () => {
    let frames = 0;
    let audio = 0;
    (await b.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesDecoded ?? 0;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') audio = s.packetsReceived ?? 0;
    });
    report({
      step: 'tick',
      visibility: document.visibilityState,
      max_timer_gap_ms: Math.round(maxGap),
      video_fps: frames - prev.frames,
      audio_pps: audio - prev.audio,
      ice: b.iceConnectionState,
    });
    prev = { frames, audio };
    maxGap = 0;
  }, 1000);
}
