import type { ReactNode } from "react";

export function cn(
  ...values: (string | false | null | undefined)[]
): string {
  return values.filter(Boolean).join(" ");
}

export function Section({
  no,
  title,
  hint,
  children,
  className,
}: {
  no: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <header className="flex items-baseline gap-2">
        <span className="font-serif text-[12px] tracking-[0.22em] text-accent">
          {no}
        </span>
        <h2 className="font-serif text-[18px] leading-none tracking-wide text-ink">
          {title}
        </h2>
        {hint ? (
          <span className="ml-auto text-[12px] text-ink-faint">{hint}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function Chip({
  active,
  onClick,
  children,
  className,
  disabled,
  title,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "min-h-8 rounded-full border px-3.5 py-2 text-[13px] leading-none transition",
        active
          ? "border-ink bg-ink text-paper shadow-[0_8px_18px_-14px_rgba(35,42,36,0.8)]"
          : "border-line bg-card/70 text-ink-soft hover:border-ink/30 hover:text-ink",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-card/70 px-3 py-2.5">
      <span className="text-[13px] text-ink-soft">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`减少${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
        >
          −
        </button>
        <span className="min-w-8 text-center font-serif text-[16px] tabular-nums text-ink">
          {value}
          {suffix ? (
            <span className="ml-0.5 text-[12px] text-ink-faint">{suffix}</span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`增加${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin-slow rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", className)}
      style={{ background: color }}
    />
  );
}
