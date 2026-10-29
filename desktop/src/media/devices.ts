// Local capture (PLAN 7.4): WebRTC's own AEC/NS/AGC on a mono 48 kHz mic, 720p30 camera.
export async function openMic(deviceId: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    },
  });
  const track = stream.getAudioTracks()[0];
  track.contentHint = 'speech';
  return track;
}

export async function openCamera(deviceId: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion';
  return track;
}
