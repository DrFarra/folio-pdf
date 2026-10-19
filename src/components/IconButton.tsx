/** A square toolbar button named by its label (for assistive technology and as its tooltip); `toggle` makes it a pressed/unpressed switch. */
export default function IconButton({ children, label, onClick, onMouseDown, disabled = false, active = false, toggle = false, className = '' }: { children: React.ReactNode; label: string; onClick: () => void; onMouseDown?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean; active?: boolean; toggle?: boolean; className?: string }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={toggle ? active : undefined} title={label} onClick={onClick} onMouseDown={onMouseDown} disabled={disabled}>{children}</button>;
}
