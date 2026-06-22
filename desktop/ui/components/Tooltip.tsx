import { useRef, useState } from "react";
import type { ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export function Tooltip({ label, children, side = "top", delay = 350, className }: Props) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);

  const show = () => {
    timer.current = window.setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setVisible(false);
  };

  return (
    <span className={`tooltip-wrap${className ? ` ${className}` : ""}`} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span className={`tooltip tooltip-${side}`} role="tooltip">
          {label}
        </span>
      )}
    </span>
  );
}
