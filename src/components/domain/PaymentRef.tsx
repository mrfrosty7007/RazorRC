import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

interface PaymentRefProps {
  /** A Razorpay identifier such as `pay_...` or `order_...`. */
  value: string;
  className?: string;
}

/**
 * Razorpay identifiers are the join key between this app and the Razorpay
 * dashboard, so they are always monospaced and always copyable.
 */
export function PaymentRef({ value, className }: PaymentRefProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard permission denied; the text stays selectable by hand.
      setCopied(false);
    }
  }

  return (
    <span className={cn('group/ref inline-flex items-center gap-1.5', className)}>
      <span className="font-mono text-micro text-content-muted" data-selectable>
        {value}
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void copy();
        }}
        aria-label={copied ? 'Copied' : `Copy ${value}`}
        className="rounded p-0.5 text-content-faint opacity-0 transition-opacity hover:text-content focus-visible:opacity-100 group-hover/ref:opacity-100"
      >
        {copied ? (
          <Check aria-hidden className="h-3 w-3 text-mint" />
        ) : (
          <Copy aria-hidden className="h-3 w-3" />
        )}
      </button>
    </span>
  );
}
