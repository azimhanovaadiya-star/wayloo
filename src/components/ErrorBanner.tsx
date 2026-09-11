/**
 * ErrorBanner — human-voiced failures, always dismissible, never raw codes.
 */

import { X, XCircle } from "lucide-react";
import type { WayloError } from "../types";

export function ErrorBanner({
  errors,
  onDismiss,
}: {
  errors: WayloError[];
  onDismiss: (id: number) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="space-y-2" role="alert" aria-live="assertive">
      {errors.map((e) => (
        <div key={e.id} className="panel p-4 flex items-start gap-3 border-destructive/60">
          <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
          <p className="flex-1 text-[15px] text-foreground leading-snug">{e.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(e.id)}
            className="shrink-0 p-2 text-muted hover:text-foreground transition-colors"
            aria-label="Dismiss message"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}