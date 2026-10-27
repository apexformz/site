import Link from 'next/link';
export function Brand({
  compact = false,
  className = '',
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/"
      aria-label="ApexFormz home"
      className={`inline-flex shrink-0 items-center gap-3 ${className}`}
    >
      <img
        src="/logo.png"
        alt=""
        className="h-11 w-11 rounded-full object-contain shadow-sm sm:h-[54px] sm:w-[54px]"
      />
      {!compact && (
        <span className="text-[20px] font-bold leading-none tracking-[-.05em] text-foreground sm:text-[25px]">
          Apex<span className="text-primary">Formz</span>
          <span className="mt-2 hidden text-xs font-medium tracking-normal text-muted sm:block">
            Move with purpose.
          </span>
        </span>
      )}
    </Link>
  );
}
