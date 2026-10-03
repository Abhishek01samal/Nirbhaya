import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function BootReveal() {
  const [done, setDone] = useState(true);
  useEffect(() => {
    if (sessionStorage.getItem("Nirbhaya-boot")) return;
    sessionStorage.setItem("Nirbhaya-boot", "1");
    setDone(false);
    const timer = window.setTimeout(() => setDone(true), 2300);
    return () => window.clearTimeout(timer);
  }, []);
  if (done) return null;
  return <div aria-hidden className="boot-screen fixed inset-0 z-[200] overflow-hidden bg-foreground text-background"><div className="boot-grid absolute inset-0" /><div className="absolute inset-x-6 top-6 flex justify-between font-mono text-[9px] uppercase tracking-[0.2em]"><span>Nirbhaya / System boot</span><span>Calibrating 98.4%</span></div><div className="absolute inset-0 grid place-items-center"><div className="text-center"><p className="boot-index font-display text-5xl">00</p><p className="boot-word font-display text-[18vw] leading-[0.75] uppercase md:text-[12vw]">Nirbhaya.</p><div className="boot-rule mx-auto mt-8 h-px w-72 bg-background" /><p className="boot-copy mt-4 font-mono text-[9px] uppercase tracking-[0.35em]">Personal safety protocol</p></div></div></div>;
}

export function RouteProgress() {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setActive(true);
    const timer = window.setTimeout(() => setActive(false), 620);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  return <div aria-hidden className={`route-wipe pointer-events-none fixed inset-0 z-[150] bg-foreground ${active ? "route-wipe-active" : ""}`}><span className="absolute bottom-8 right-8 font-mono text-[9px] uppercase tracking-[0.3em] text-background">Reconfiguring grid</span></div>;
}

export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { setShown(true); observer.disconnect(); } }, { threshold: 0.08 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} style={{ transitionDelay: `${delay}ms` }} className={`reveal ${shown ? "reveal-in" : ""} ${className}`}>{children}</div>;
}