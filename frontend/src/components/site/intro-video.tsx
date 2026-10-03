import { useEffect, useRef, useState } from "react";

export function IntroVideo() {
  const [phase, setPhase] = useState<"video" | "flash" | "done">("video");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Browsers block autoplay with sound on refresh; try with audio first,
    // fall back to muted so the intro still plays every time.
    video.play().catch(() => {
      video.muted = true;
      void video.play().catch(() => setPhase("done"));
    });
  }, []);

  if (phase === "done") return null;

  return (
    <div className={`fixed inset-0 z-[9999] ${phase === "video" ? "bg-black" : "bg-transparent pointer-events-none"}`}>
      {phase === "video" && (
        <video
          ref={videoRef}
          src="/nirbhaya-final.mp4"
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          onEnded={() => setPhase("flash")}
          onError={() => setPhase("done")}
        />
      )}
      {phase === "flash" && (
        <div className="absolute inset-0 bg-white" style={{ animation: "intro-flash 600ms ease-out forwards" }} onAnimationEnd={() => setPhase("done")} />
      )}
      <style>{`@keyframes intro-flash { 0% { opacity: 1 } 20% { opacity: 1 } 100% { opacity: 0 } }`}</style>
    </div>
  );
}
