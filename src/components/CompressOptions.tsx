import { useState } from 'react';
import { COMPRESSION_PRESETS, type CompressionSettings } from '../engine/compression-settings';
import { formatSize } from '../pdf';
import './CompressOptions.css';

type Level = keyof typeof COMPRESSION_PRESETS | 'custom';

const LEVELS: { value: Level; label: string; hint: string }[] = [
  {
    value: 'lossless',
    label: 'Sin pérdida',
    hint: 'Cada página queda idéntica: solo se reorganiza el archivo y se quitan datos que nadie muestra.',
  },
  {
    value: 'high',
    label: 'Alta calidad',
    hint: 'Para imprimir: las imágenes conservan 300 ppp a su tamaño en la página y las fuentes solo guardan las letras que se usan.',
  },
  {
    value: 'balanced',
    label: 'Equilibrada (recomendada)',
    hint: 'Imágenes a 200 ppp: en pantalla y al imprimir la diferencia apenas se nota.',
  },
  { value: 'strong', label: 'Fuerte', hint: 'Imágenes a 150 ppp: para leer en pantalla.' },
  {
    value: 'maximum',
    label: 'Máxima',
    hint: 'Imágenes a 100 ppp: el archivo más pequeño, para enviarlo por correo o mensaje.',
  },
  { value: 'custom', label: 'Personalizada', hint: 'Elige la resolución y la calidad de las fotos.' },
];

type Props = {
  size: number;
  busy: boolean;
  onCompress: (settings: CompressionSettings) => void;
};

export default function CompressOptions({ size, busy, onCompress }: Props) {
  const [level, setLevel] = useState<Level>('balanced');
  const [custom, setCustom] = useState<CompressionSettings>({ ...COMPRESSION_PRESETS.balanced });
  const settings = level === 'custom' ? custom : COMPRESSION_PRESETS[level];
  return (
    <>
      <p className="modal-description">
        Tamaño actual: {formatSize(size)}. Las imágenes solo se recomprimen si el cambio no se nota; los dibujos,
        gráficos y capturas mantienen sus bordes nítidos.
      </p>
      <div className="security-form">
        <label>
          Nivel de compresión
          <select
            aria-label="Nivel de compresión"
            value={level}
            disabled={busy}
            onChange={event => setLevel(event.target.value as Level)}
          >
            {LEVELS.map(item => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {level === 'custom' && (
          <>
            <label>
              Resolución máxima de las imágenes
              <div className="compress-range">
                <input
                  aria-label="Resolución máxima de las imágenes"
                  type="range"
                  min="72"
                  max="600"
                  step="1"
                  value={custom.resolution}
                  disabled={busy}
                  onChange={event => setCustom({ ...custom, resolution: Number(event.target.value) })}
                />
                <output>{custom.resolution} ppp</output>
              </div>
            </label>
            <label>
              Calidad de las fotos
              <div className="compress-range">
                <input
                  aria-label="Calidad de las fotos"
                  type="range"
                  min="30"
                  max="95"
                  step="1"
                  value={custom.quality}
                  disabled={busy}
                  onChange={event => setCustom({ ...custom, quality: Number(event.target.value) })}
                />
                <output>{custom.quality}</output>
              </div>
            </label>
          </>
        )}
      </div>
      <p className="area-label">{LEVELS.find(item => item.value === level)!.hint}</p>
      <div className="operation-actions">
        <button className="primary-button" disabled={busy} onClick={() => onCompress(settings)}>
          Comprimir
        </button>
      </div>
    </>
  );
}
