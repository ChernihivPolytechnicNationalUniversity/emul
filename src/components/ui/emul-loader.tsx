import { cn } from "@/lib/utils"

/**
 * The εmul loading loop (source: the emul-loader Remotion project, `npm run export`).
 *
 * The clip is white-on-black and composited rather than alpha-keyed: inverted + multiply on
 * light, screen on dark, so its plate vanishes on whatever is behind it — and Safari, which has
 * no VP9 alpha, gets the H.264 fallback with the same result. The same recipe as the boot splash
 * in index.html, which can't use this component because it shows before React exists.
 * Reduced motion gets the still mark instead.
 */
export function EmulLoader({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block size-24 shrink-0", className)} aria-hidden="true">
      <video
        className="size-full invert mix-blend-multiply motion-reduce:hidden dark:invert-0 dark:mix-blend-screen"
        autoPlay
        loop
        muted
        playsInline
        disablePictureInPicture
        preload="auto"
      >
        <source src="/loader/emul-loader.webm" type="video/webm; codecs=vp9" />
        <source src="/loader/emul-loader.mp4" type="video/mp4" />
      </video>
      <img className="absolute inset-[22%] hidden opacity-85 motion-reduce:block dark:invert" src="/mark.svg" alt="" />
    </span>
  )
}
