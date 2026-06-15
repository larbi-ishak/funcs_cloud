export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="h-9 w-48 bg-accent/50 rounded-md animate-pulse" />
        <div className="h-5 w-72 bg-accent/30 rounded-md animate-pulse mt-2" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[1, 2, 3].map(i => (
          <div key={i} className="border border-border rounded-xl bg-card overflow-hidden shadow-sm">
            <div className="p-5 space-y-4">
              <div className="h-6 w-32 bg-accent/50 rounded animate-pulse" />
              <div className="h-4 w-48 bg-accent/30 rounded animate-pulse" />
              <div className="h-10 w-full bg-accent/20 rounded animate-pulse" />
              <div className="h-10 w-full bg-accent/20 rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}