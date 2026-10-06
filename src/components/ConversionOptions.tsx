import { useEffect, useMemo, useState } from 'react';
import { FileOutput, LoaderCircle } from 'lucide-react';
import type { LoadedDocument } from '../types';
import { conversionPages, DEFAULT_PNG_EXPORT_OPTIONS, pngPageDimensions } from '../conversion';
import { errorMessage } from '../errors';
import { plural } from '../pdf';
import type { ConversionFormat, ConversionScope, PngExportOptions } from '../conversion';
import './ConversionOptions.css';

type Props = {
  doc: LoadedDocument;
  page: number;
  busy: boolean;
  onConvert: (format: ConversionFormat, pages: number[], options?: PngExportOptions) => void;
};

export default function ConversionOptions({ doc, page, busy, onConvert }: Props) {
  const [format, setFormat] = useState<ConversionFormat>('docx');
  const [scope, setScope] = useState<ConversionScope>('current');
  const [range, setRange] = useState(String(page));
  const [png, setPng] = useState<PngExportOptions>({ ...DEFAULT_PNG_EXPORT_OPTIONS });
  const [sample, setSample] = useState<{ page: number; width: number; height: number } | null>(null);
  const [sampleError, setSampleError] = useState('');
  const selection = useMemo(() => {
    try { return { pages: conversionPages(scope, range, page, doc.pdf.numPages), error: '' }; }
    catch (error) { return { pages: [], error: (error as Error).message }; }
  }, [scope, range, page, doc.pdf.numPages]);
  const firstPage = selection.pages[0];
  useEffect(() => {
    setSample(null); setSampleError('');
    if (format !== 'png' || !firstPage) return;
    let alive = true;
    void doc.pdf.getPage(firstPage).then(value => {
      const view = value.getViewport({ scale: 1 });
      if (alive) setSample({ page: firstPage, width: view.width, height: view.height });
    }).catch(error => { if (alive) setSampleError(errorMessage(error, 'No se pudo leer el tamaño de la página.')); });
    return () => { alive = false; };
  }, [doc.pdf, firstPage, format]);
  const estimate = useMemo(() => {
    if (format !== 'png' || !sample || sample.page !== firstPage) return { label: '', error: '' };
    try {
      const size = pngPageDimensions(sample.width, sample.height, png.dpi);
      return { label: `Página ${sample.page}: ${size.width.toLocaleString('es')} × ${size.height.toLocaleString('es')} píxeles.`, error: '' };
    } catch (error) { return { label: '', error: (error as Error).message }; }
  }, [sample, firstPage, format, png.dpi]);
  const error = selection.error || (format === 'png' ? sampleError || estimate.error : '');
  return <div className="conversion-options">
    <fieldset disabled={busy} className="conversion-fields">
      <div className="security-form">
        <label>Formato<select aria-label="Formato de exportación" value={format} onChange={event => setFormat(event.target.value as ConversionFormat)}>
          <option value="docx">Word — texto editable (.docx)</option>
          <option value="txt">Texto (.txt)</option>
          <option value="png">Imágenes PNG (.zip)</option>
        </select></label>
        <label>Páginas a exportar<select aria-label="Páginas a exportar" value={scope} onChange={event => setScope(event.target.value as ConversionScope)}>
          <option value="current">Página actual ({page})</option>
          <option value="all">Todas ({plural(doc.pdf.numPages, 'página', 'páginas')})</option>
          <option value="range">Un intervalo o varias páginas</option>
        </select></label>
        {scope === 'range' && <label>Intervalo<input aria-label="Intervalo de páginas" value={range} onChange={event => setRange(event.target.value)} placeholder="1-3, 6" maxLength={50_000} /><small>Usa números de página del archivo, por ejemplo 1-3, 6.</small></label>}
      </div>
      {format === 'png' ? <>
        <div className="conversion-image-properties security-form">
          <label>Resolución<select aria-label="Resolución PNG" value={png.dpi} onChange={event => setPng({ ...png, dpi: Number(event.target.value) as PngExportOptions['dpi'] })}>
            <option value={72}>72 ppp — pantalla, archivo pequeño</option>
            <option value={144}>144 ppp — equilibrada</option>
            <option value={200}>200 ppp — más detalle</option>
            <option value={300}>300 ppp — impresión</option>
          </select></label>
          <label>Fondo<select aria-label="Fondo PNG" value={png.background} onChange={event => setPng({ ...png, background: event.target.value as PngExportOptions['background'] })}>
            <option value="white">Blanco</option><option value="transparent">Transparente</option>
          </select></label>
        </div>
        <p className="conversion-description">Se guarda una imagen PNG por página en un archivo ZIP.</p>
        {png.background === 'transparent' && <p className="conversion-description">El fondo transparente conserva los fondos blancos que ya estén dibujados dentro del PDF.</p>}
        {estimate.label && <p className="conversion-dimensions">{estimate.label}</p>}
      </> : <p className="conversion-description">{format === 'docx' ? 'Exporta el texto editable con separación de páginas. Las imágenes, tablas y distribución original no se trasladan a Word.' : 'Extrae el texto de las páginas elegidas, en su orden. Los PDF escaneados necesitan reconocer texto con OCR primero.'}</p>}
    </fieldset>
    {error && <p className="operation-error" role="alert">{error}</p>}
    <div className="operation-actions conversion-actions">
      <span className="conversion-selection-summary" role="status" aria-live="polite">{selection.pages.length ? plural(selection.pages.length, 'página seleccionada', 'páginas seleccionadas') : 'Sin páginas válidas'}</span>
      <button type="button" className="primary-button" disabled={busy || !doc.canCopy || !!error || !selection.pages.length} onClick={() => {
        if (!busy && doc.canCopy && !error && selection.pages.length) onConvert(format, [...selection.pages], format === 'png' ? { ...png } : undefined);
      }}>{busy ? <LoaderCircle size={16} className="spin" /> : <FileOutput size={16} />}Convertir a {format === 'png' ? 'PNG' : format === 'docx' ? 'Word' : 'texto'}</button>
    </div>
  </div>;
}
