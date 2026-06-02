"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Terminal, Trash2, Zap, RefreshCw, Layers } from "lucide-react";

export default function Dashboard() {
  const [functions, setFunctions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFunctions = async () => {
    try {
      const res = await fetch("http://localhost:3002/functions");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setFunctions(data.functions);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFunctions();
    const t = setInterval(fetchFunctions, 5000);
    return () => clearInterval(t);
  }, []);

  const deleteFunction = async (id: string, name: string) => {
    if (!confirm(`Delete function '${name}'?`)) return;
    try {
      await fetch(`http://localhost:3002/functions/${id}`, { method: "DELETE" });
      fetchFunctions();
    } catch (e) {
      alert("Failed to delete");
    }
  };

  const replenishFunction = async (id: string) => {
    try {
      await fetch(`http://localhost:3002/warm-pool/${id}/replenish`, { method: "POST" });
      alert("Replenishment triggered");
    } catch (e) {
      alert("Failed to replenish");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add a toast here
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Functions</h1>
        <p className="text-muted-foreground mt-1">Manage your deployed serverless functions and warm pools.</p>
      </div>

      {loading && functions.length === 0 ? (
        <div className="h-64 flex items-center justify-center border border-border rounded-lg border-dashed">
          <RefreshCw className="animate-spin text-muted-foreground mr-2" />
          <span className="text-muted-foreground">Loading functions...</span>
        </div>
      ) : functions.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center border border-border rounded-lg border-dashed bg-accent/20">
          <Layers className="h-10 w-10 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No functions deployed</h3>
          <p className="text-sm text-muted-foreground mt-1 mb-4">Get started by deploying your first function.</p>
          <Link href="/deploy" className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors">
            Deploy Function
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {functions.map((f) => {
            const isProd = f.status === "active";
            const mem = f.memory_limit || 512;
            const cpu = f.cpu_limit || 1.0;
            const storage = f.storage_limit || 512;
            const max = f.max_containers || 10;
            const pct = Math.min(100, Math.round((f.claimed_count / max) * 100));

            return (
              <div key={f.id} className="border border-border rounded-xl bg-card text-card-foreground overflow-hidden flex flex-col shadow-sm">
                <div className="p-5 border-b border-border">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-semibold text-lg">{f.name}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isProd ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500'}`}>
                      {f.status}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-4 font-mono truncate" title={f.image}>
                    {f.image.split('/').pop()}
                  </div>

                  <div className="space-y-2 mb-4">
                    <div className="flex items-center gap-2 bg-accent/30 rounded-md px-2 py-1.5 border border-border">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-500">PATH</span>
                      <span className="text-xs font-mono text-muted-foreground truncate flex-1">{`http://localhost:8081/fn/${f.name}`}</span>
                      <button onClick={() => copyToClipboard(`http://localhost:8081/fn/${f.name}`)} className="text-muted-foreground hover:text-foreground">
                        <Copy size={12} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 bg-accent/30 rounded-md px-2 py-1.5 border border-border">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-500">HOST</span>
                      <span className="text-xs font-mono text-muted-foreground truncate flex-1">{`http://${f.name}.localhost:8081/`}</span>
                      <button onClick={() => copyToClipboard(`http://${f.name}.localhost:8081/`)} className="text-muted-foreground hover:text-foreground">
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex gap-4 mb-4 text-xs">
                    <div className="flex flex-col">
                      <span className="text-muted-foreground mb-1">Memory</span>
                      <span className="font-medium">{mem} MB</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-muted-foreground mb-1">vCPU</span>
                      <span className="font-medium">{cpu}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-muted-foreground mb-1">Max</span>
                      <span className="font-medium">{max} inst</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Warm Pool: {f.warm_count} ready</span>
                      <span>{f.claimed_count} active</span>
                    </div>
                    <div className="h-2 w-full bg-accent rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-accent/30 grid grid-cols-3 gap-2">
                  <Link href={`/functions/${f.id}`} className="flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors">
                    <Terminal size={14} /> Details
                  </Link>
                  <button onClick={() => replenishFunction(f.id)} className="flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-orange-500">
                    <Zap size={14} /> Replenish
                  </button>
                  <button onClick={() => deleteFunction(f.id, f.name)} className="flex items-center justify-center gap-2 py-2 text-xs font-medium hover:bg-accent rounded-md transition-colors text-red-500">
                    <Trash2 size={14} /> Delete
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
