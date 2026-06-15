"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="h-64 flex flex-col items-center justify-center border border-red-500/30 rounded-lg bg-red-500/5">
      <h2 className="text-lg font-semibold text-red-500 mb-2">Something went wrong</h2>
      <p className="text-sm text-muted-foreground mb-4">{error.message}</p>
      <button
        onClick={reset}
        className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}