import { useEffect, useRef, useState } from "react";

/** A button that asks for confirmation inline instead of with a dialog. */
export function ConfirmButton({ label, confirmLabel, question, onConfirm, className = "btn danger" }: { label: string; confirmLabel: string; question: string; onConfirm: () => void | Promise<void>; className?: string }) {
  const [arming, setArming] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!arming) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setArming(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArming(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [arming]);
  if (!arming) return <button className={className} onClick={() => setArming(true)}>{label}</button>;
  return (
    <span className="confirm" ref={ref} role="group" aria-label={question}>
      <span className="muted">{question}</span>
      <button className="btn danger" autoFocus onClick={() => { setArming(false); void onConfirm(); }}>{confirmLabel}</button>
      <button className="btn" onClick={() => setArming(false)}>Cancel</button>
    </span>
  );
}
