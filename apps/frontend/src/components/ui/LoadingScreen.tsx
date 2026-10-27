import { ScanLine } from 'lucide-react';
export function LoadingScreen({
  label = 'Preparing your training space',
}: {
  label?: string;
}) {
  return (
    <div
      className="flex min-h-[75vh] flex-col items-center justify-center gap-9 px-6"
      role="status"
      aria-live="polite"
    >
      <div className="orbit-loader">
        <ScanLine size={34} className="text-primary" strokeWidth={1.5} />
      </div>
      <div className="text-center">
        <p className="mb-2 text-lg font-semibold text-foreground">{label}</p>
        <p className="text-sm text-muted">A moment for your next move.</p>
      </div>
      <div className="h-1 w-40 overflow-hidden rounded-full bg-primary/10">
        <div className="skeleton-shimmer h-full w-full" />
      </div>
    </div>
  );
}
