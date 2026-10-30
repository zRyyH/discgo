import { useEffect, useState } from 'react';
import { useSettings } from '../stores/settings';
import { Card, Toggle } from './ui';

/** Device selection (PLAN 7.4: enumerateDevices + setSinkId). */
export function VoiceSettings() {
  const s = useSettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const refresh = () => void navigator.mediaDevices.enumerateDevices().then(setDevices);
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  const pick = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind && d.deviceId);

  return (
    <>
      <h2 className="mb-4 text-title font-semibold">Voz e vídeo</h2>
      <Card className="grid grid-cols-2 gap-4">
        <Select label="Microfone" value={s.inputDeviceId} options={pick('audioinput')} onChange={(v) => s.update({ inputDeviceId: v })} />
        <Select label="Saída de áudio" value={s.outputDeviceId} options={pick('audiooutput')} onChange={(v) => s.update({ outputDeviceId: v })} />
        <Select
          label="Câmera"
          value={s.videoDeviceId}
          options={pick('videoinput')}
          empty="Nenhuma câmera encontrada"
          onChange={(v) => s.update({ videoDeviceId: v })}
        />
      </Card>
      <Card className="mt-4 py-2">
        <Toggle label="Voz em alta qualidade" checked={s.highQualityVoice} onChange={(v) => s.update({ highQualityVoice: v })} />
      </Card>
    </>
  );
}

function Select(props: { label: string; value: string; options: MediaDeviceInfo[]; empty?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-semibold text-text-2">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-border bg-bg-0 px-2 text-body text-text-1 outline-none transition-colors duration-150 focus:border-accent"
      >
        {props.options.length === 0 && <option value="">{props.empty ?? 'Padrão do sistema'}</option>}
        {props.options.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || (d.deviceId === 'default' ? 'Padrão do sistema' : d.deviceId.slice(0, 8))}
          </option>
        ))}
      </select>
    </label>
  );
}
