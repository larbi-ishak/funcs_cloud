"use client";

import { useEffect, useState } from "react";
import { Server, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchWorkers = async () => {
    try {
      const res = await fetch("http://localhost:3002/workers");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setWorkers(data.workers);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkers();
    const t = setInterval(fetchWorkers, 5000);
    return () => clearInterval(t);
  }, []);

  const deleteWorker = async (id: string, ip: string) => {
    if (!confirm(`Remove worker ${ip}?`)) return;
    try {
      await fetch(`http://localhost:3002/workers/${id}?remove=true`, { method: "DELETE" });
      fetchWorkers();
    } catch (e) {
      alert("Failed to delete");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Worker Pool</h1>
        <p className="text-muted-foreground mt-1">Manage physical/virtual machines providing placement capacity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {workers.length === 0 && !loading && (
          <div className="col-span-3 h-32 flex items-center justify-center border border-border border-dashed rounded-lg bg-accent/20 text-muted-foreground">
            No workers registered. Use API POST /init to add a worker.
          </div>
        )}

        {workers.map(w => {
          const isHealthy = w.status === "healthy";
          return (
            <div key={w.id} className="border border-border rounded-xl bg-card overflow-hidden shadow-sm flex flex-col">
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Server className={isHealthy ? "text-green-500" : "text-red-500"} />
                  <div>
                    <h3 className="font-semibold">{w.ip}</h3>
                    <p className="text-xs text-muted-foreground font-mono">{w.id.split("-")[0]}</p>
                  </div>
                </div>
                {isHealthy ? <CheckCircle2 className="text-green-500" size={20} /> : <AlertCircle className="text-red-500" size={20} />}
              </div>
              <div className="p-4 bg-accent/20 flex-1 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className={`font-medium ${isHealthy ? 'text-green-500' : 'text-red-500'}`}>{w.status.toUpperCase()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Failures</span>
                  <span>{w.consecutive_failures}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Memory</span>
                  <span>{w.total_memory_mb} MB</span>
                </div>
              </div>
              <div className="p-3 border-t border-border bg-card">
                <button onClick={() => deleteWorker(w.id, w.ip)} className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-red-500">
                  <Trash2 size={14} /> Remove Node
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
