import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/domain';

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** Adds a leading status dot. Use for lifecycle states, not categories. */
  dot?: boolean;
  /** Animates the dot. Reserved for states that are genuinely live. */
  live?: boolean;
  title?: string;
  className?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  live = false,
  title,
  className,
}: BadgeProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border px-1.5 py-0.5 text-micro font-medium',
        classes.bg,
        classes.border,
        classes.text,
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', classes.dot, live && 'animate-live-pulse')}
        />
      ) : null}
      {children}
    </span>
  );
}

/** Category chip: no dot, monospaced, for enum-like values in dense tables. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-control border border-hairline-strong bg-overlay px-1.5 py-0.5 font-mono text-micro text-content-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
