// Logo Hermes Web — cercle « aile » + forme d'onde de chat
export function HermesLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle
        cx="16"
        cy="16"
        r="13"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M9.5 20.5c1.6-4.6 3-4.6 4.6 0 1.6-4.6 3-4.6 4.6 0 1.6-4.6 3-4.6 4.6 0"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Avatar de l'assistant dans les messages
export function HermesAvatar({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-hermes text-hermes-foreground ${className}`}
      aria-hidden="true"
    >
      <HermesLogo className="h-[70%] w-[70%]" />
    </span>
  );
}
