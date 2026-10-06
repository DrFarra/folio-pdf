import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { watchDesktopModalViewport } from '../desktop-modal-viewport';
import './Modal.css';

/** Shared dismissal affordance for mobile dialogs and the PDF explorer. Drag
 * only from the handle: scrolling, text selection and form inputs stay native.
 * It is a pointer gesture aid; keyboards and screen readers use the close button. */
export function SheetHandle({ onClose, label = 'Cerrar hoja' }: { onClose: () => void; label?: string }) {
  const gesture = useRef<{ pointerId: number; x: number; y: number; at: number; offset: number; target: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  const reset = () => {
    const active = gesture.current;
    if (active) { active.target.style.removeProperty('translate'); active.target.classList.remove('sheet-dragging'); }
    gesture.current = null;
  };
  useEffect(() => reset, []);
  return <button type="button" className="sheet-handle" aria-label={label} tabIndex={-1} aria-hidden="true" onClick={event => {
    if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
    onClose();
  }} onPointerDown={event => {
    if (!document.documentElement.hasAttribute('data-phone') || event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.currentTarget.closest<HTMLElement>('dialog.modal, .mobile-drawer');
    if (!target) return;
    suppressClick.current = false;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), offset: 0, target };
    event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={event => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = event.clientY - active.y;
    if (Math.abs(event.clientX - active.x) > 24 && Math.abs(delta) < 12) { suppressClick.current = true; reset(); return; }
    active.offset = Math.max(0, delta);
    if (Math.abs(delta) > 6) suppressClick.current = true;
    if (active.offset > 0) {
      active.target.classList.add('sheet-dragging');
      active.target.style.translate = `0 ${active.offset}px`;
    }
  }} onPointerUp={event => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const velocity = active.offset / Math.max(1, performance.now() - active.at);
    const dismiss = active.offset >= 80 || active.offset >= 36 && velocity > .7;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    reset();
    if (dismiss) { suppressClick.current = true; onClose(); }
  }} onPointerCancel={() => { suppressClick.current = true; reset(); }}><span aria-hidden="true" /></button>;
}

export default function Modal({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Capture before child autoFocus runs during commit, especially note editors.
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const backdropDown = useRef(false);
  // A sheet may open on touch pointerup. Its compatibility mouse click must not
  // activate a newly mounted button at that same screen coordinate. A fresh
  // pointerdown arms pointer clicks; keyboard and accessibility clicks still work.
  const pointerClickArmed = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    // React focuses autoFocus controls while the dialog is still closed.
    // Mark the intended field before showModal so WebKit's dialog focusing
    // steps choose it, rather than the sheet's first dismissal button.
    const initialFocus = dialog?.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    initialFocus?.setAttribute('autofocus', '');
    dialog?.showModal();
    (initialFocus ?? dialog?.querySelector<HTMLElement>('.modal-heading button'))?.focus({ preventScroll: true });
    const stopViewport = ref.current ? watchDesktopModalViewport(ref.current) : () => {};
    return () => { stopViewport(); ref.current?.close(); if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`modal mobile-sheet ${className}`} onCancel={event => {
    // A dismissed file chooser inside the dialog fires a bubbling `cancel` of its own.
    if (event.target !== event.currentTarget) return;
    event.preventDefault(); onClose();
  }} onPointerDownCapture={() => { pointerClickArmed.current = true; }} onClickCapture={event => {
    if (event.detail > 0 && !pointerClickArmed.current) { event.preventDefault(); event.stopPropagation(); }
    pointerClickArmed.current = false;
  }} onPointerDown={event => {
    const box = event.currentTarget.getBoundingClientRect();
    backdropDown.current = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  }} onPointerCancel={() => { backdropDown.current = false; pointerClickArmed.current = false; }} onClick={event => {
    if (event.target === ref.current && backdropDown.current) onClose();
    backdropDown.current = false;
  }} aria-labelledby={titleId}>
    <SheetHandle onClose={onClose} />
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Cerrar diálogo"><X size={19} /></button></div>
    {children}
  </dialog>;
}
