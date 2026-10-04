import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { watchDesktopModalViewport } from '../desktop-modal-viewport';

export default function Modal({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const backdropDown = useRef(false);
  const titleId = useId();
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    ref.current?.showModal();
    const stopViewport = ref.current ? watchDesktopModalViewport(ref.current) : () => {};
    return () => { stopViewport(); ref.current?.close(); previousFocus.current?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onPointerDown={event => {
    const box = event.currentTarget.getBoundingClientRect();
    backdropDown.current = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  }} onPointerCancel={() => { backdropDown.current = false; }} onClick={event => {
    if (event.target === ref.current && backdropDown.current) onClose();
    backdropDown.current = false;
  }} aria-labelledby={titleId}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Cerrar diálogo"><X size={19} /></button></div>
    {children}
  </dialog>;
}
