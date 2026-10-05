import { useId, useRef } from 'react';
import { Upload } from 'lucide-react';
import './FilePicker.css';

type Props = {
  label: string;
  accept: string;
  buttonText?: string;
  description?: string;
  selectedName?: string;
  multiple?: boolean;
  disabled?: boolean;
  resetAfterSelect?: boolean;
  onSelect: (files: File[]) => void;
};

/** Keep the platform picker, but give every file field the same visible control. */
export default function FilePicker({ label, accept, buttonText = 'Elegir archivo', description, selectedName, multiple, disabled, resetAfterSelect = multiple, onSelect }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div className="file-picker">
    <span id={`${id}-label`} className="file-picker-label">{label}</span>
    <div className="file-picker-control">
      <button type="button" className="secondary-button file-picker-button" disabled={disabled} aria-describedby={`${id}-label ${id}-status`} onClick={() => input.current?.click()}>
        <Upload size={18} aria-hidden="true" /><span>{buttonText}</span>
      </button>
      <span id={`${id}-status`} className={`file-picker-status${selectedName ? ' has-file' : ''}`} title={selectedName} aria-live="polite">{selectedName || description || 'Ningún archivo seleccionado'}</span>
    </div>
    <input ref={input} type="file" hidden aria-label={label} accept={accept} multiple={multiple} disabled={disabled} onChange={event => {
      const files = Array.from(event.currentTarget.files || []);
      if (files.length) onSelect(files);
      if (resetAfterSelect) event.currentTarget.value = '';
    }} />
  </div>;
}
