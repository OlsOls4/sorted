export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-extrabold tracking-tight ${className}`}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="#0a7f5a" />
        <path d="M21.5 11.2a7 7 0 1 0 0 9.6" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
        <path d="M18 16h8m0 0-3-3m3 3-3 3" fill="none" stroke="#bff0db" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Chase</span>
    </span>
  );
}
