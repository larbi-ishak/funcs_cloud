export default function Loading() {
  return (
    <div className="h-64 flex items-center justify-center border border-border rounded-lg border-dashed">
      <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full mr-3" />
      <span className="text-muted-foreground">Loading metrics...</span>
    </div>
  );
}