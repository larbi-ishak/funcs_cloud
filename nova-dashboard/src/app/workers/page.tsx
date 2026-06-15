"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Server, CheckCircle2, AlertCircle, Trash2, RefreshCw, RotateCw, Eye } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkers = async () => {
    try {
      const res = await fetch(`${API_URL}/workers`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setWorkers(data.workers);
      setError(null);
    } catch (e: any) {
      setError(e.message);
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
    if (!confirm(`Remove worker ${ip}?\n\nThis will retire the worker, stop all its containers, and remove it from the pool.`)) return;
    try {
      await fetch(`${API_URL}/workers/${id}?remove=true`, { method: "DELETE" });
      fetchWorkers();
    } catch (e) {
      alert("Failed to delete");
    }
  };

  const retryWorker = async (id: string, ip: string) => {
    try {
      const res = await fetch(`${API_URL}/workers/${id}/retry`, { method: "POST" });
      const data = await res.json();
      if (data.healthy) {
        alert(`Worker ${ip} is back online! ✅`);
      } else {
        alert(`Worker ${ip} is still unreachable: ${data.reason || 'unknown error'}`);
      }
      fetchWorkers();
    } catch (e) {
      alert("Failed to retry connection");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Worker Pool</h1>
        <p className="text-muted-foreground mt-1">Manage physical/virtual machines providing placement capacity.</p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-500 text-sm">
          Failed to fetch workers: {error}
        </div>
      )}

      {loading ? (
        <div className="h-64 flex items-center justify-center border border-border rounded-lg border-dashed">
          <RefreshCw className="animate-spin text-muted-foreground mr-2" />
          <span className="text-muted-foreground">Loading workers...</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {workers.length === 0 && (
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
                <div className="p-3 border-t border-border bg-card space-y-2">
                  <Link href={`/workers/${w.id}`} className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-blue-400">
                    <Eye size={14} /> Details
                  </Link>
                  {(w.status === "faulty" || w.status === "retired" || w.status === "degraded" || w.status === "pending") && (
                    <button onClick={() => retryWorker(w.id, w.ip)} className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-orange-500">
                      <RotateCw size={14} /> Retry Connection
                    </button>
                  )}
                  <button onClick={() => deleteWorker(w.id, w.ip)} className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-red-500">
                    <Trash2 size={14} /> Remove Node
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}