"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, Terminal, Activity, Layers, Database, Cpu, Copy, Clock, CheckCircle2, AlertCircle, MemoryStick } from "lucide-react";
import Link from "next/link";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function FunctionDetailsPage() {
  const { id } = useParams();
  const router = useRouter();
  const [func, setFunc] = useState<any>(null);
  const [liveStats, setLiveStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchDetails = async () => {
    try {
      const [funcRes, statsRes] = await Promise.allSettled([
        fetch(`${API_URL}/functions/${id}`).then((r) => r.json()),
        fetch(`${API_URL}/functions/${id}/stats`).then((r) => r.json()),
      ]);

      if (funcRes.status === "fulfilled") setFunc(funcRes.value);
      if (statsRes.status === "fulfilled") setLiveStats(statsRes.value);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
    const t = setInterval(fetchDetails, 5000);
    return () => clearInterval(t);
  }, [id]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading && !func) {
    return (
      <div className="h-64 flex items-center justify-center">
        <RefreshCw className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!func) {
    return (
      <div>
        <button onClick={() => router.back()} className="flex items-center text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft size={16} className="mr-1" /> Back
        </button>
        <div className="text-xl font-semibold text-red-500">Function not found.</div>
      </div>
    );
  }

  const { function: f, invocations } = func;
  const mem = f.memory_limit || 512;
  const cpu = f.cpu_limit || 1.0;
  const storage = f.storage_limit || 512;
  const totalInvs = invocations?.length || 0;
  
  const successes = invocations?.filter((i: any) => i.status_code >= 200 && i.status_code < 400).length || 0;
  const errors = totalInvs - successes;
  const successRate = totalInvs > 0 ? Math.round((successes / totalInvs) * 100) : 0;
  const avgLatency = totalInvs > 0 ? Math.round(invocations.reduce((acc: number, i: any) => acc + (i.latency_ms || 0), 0) / totalInvs) : 0;

  return (
    <div className="space-y-6">
      <button onClick={() => router.back()} className="flex items-center text-sm text-muted-foreground hover:text-foreground mb-2">
        <ArrowLeft size={16} className="mr-1" /> Back to Dashboard
      </button>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{f.name}</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">{f.id}</p>
        </div>
        
        <div className="space-y-2 min-w-[300px]">
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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-card border border-border p-5 rounded-xl shadow-sm flex items-center gap-4">
          <div className="h-10 w-10 bg-blue-500/10 flex items-center justify-center rounded-lg text-blue-500">
            <Activity size={20} />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Total Invocations</div>
            <div className="text-2xl font-bold">{totalInvs}</div>
          </div>
        </div>
        <div className="bg-card border border-border p-5 rounded-xl shadow-sm flex items-center gap-4">
          <div className="h-10 w-10 bg-yellow-500/10 flex items-center justify-center rounded-lg text-yellow-500">
            <Clock size={20} />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Avg Latency</div>
            <div className="text-2xl font-bold">{avgLatency} <span className="text-sm font-normal text-muted-foreground">ms</span></div>
          </div>
        </div>
        <div className="bg-card border border-border p-5 rounded-xl shadow-sm flex items-center gap-4">
          <div className="h-10 w-10 bg-green-500/10 flex items-center justify-center rounded-lg text-green-500">
            <CheckCircle2 size={20} />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Success Rate</div>
            <div className="text-2xl font-bold">{successRate}%</div>
          </div>
        </div>
        <div className="bg-card border border-border p-5 rounded-xl shadow-sm flex items-center gap-4">
          <div className="h-10 w-10 bg-red-500/10 flex items-center justify-center rounded-lg text-red-500">
            <AlertCircle size={20} />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Errors</div>
            <div className="text-2xl font-bold">{errors}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border p-4 rounded-xl shadow-sm flex items-center gap-3">
          <Layers size={16} className="text-purple-500" />
          <div className="flex-1">
            <div className="text-xs text-muted-foreground">Memory Limit</div>
            <div className="font-semibold">{mem >= 1024 ? `${mem/1024} GB` : `${mem} MB`}</div>
            {liveStats?.aggregated?.memory_used_bytes > 0 && (
              <div className="text-xs text-green-500 mt-1">
                Using {formatBytes(liveStats.aggregated.memory_used_bytes)} live
              </div>
            )}
          </div>
        </div>
        <div className="bg-card border border-border p-4 rounded-xl shadow-sm flex items-center gap-3">
          <Cpu size={16} className="text-orange-500" />
          <div className="flex-1">
            <div className="text-xs text-muted-foreground">vCPU Limit</div>
            <div className="font-semibold">{cpu} vCPU</div>
            {liveStats?.aggregated?.cpu_percent > 0 && (
              <div className="text-xs text-blue-500 mt-1">
                {liveStats.aggregated.cpu_percent.toFixed(1)}% used live
              </div>
            )}
          </div>
        </div>
        <div className="bg-card border border-border p-4 rounded-xl shadow-sm flex items-center gap-3">
          <Database size={16} className="text-green-500" />
          <div>
            <div className="text-xs text-muted-foreground">Storage Limit</div>
            <div className="font-semibold">{storage >= 1024 ? `${storage/1024} GB` : `${storage} MB`}</div>
          </div>
        </div>
      </div>

      {/* Live Container Stats */}
      {liveStats?.containers?.length > 0 && (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-accent/30 flex items-center gap-2">
            <MemoryStick size={16} className="text-muted-foreground" />
            <h3 className="font-semibold text-sm">Live Container Stats</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-accent/20 text-muted-foreground text-xs uppercase border-b border-border">
                <tr>
                  <th className="px-6 py-3 font-medium">Container</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">CPU %</th>
                  <th className="px-6 py-3 font-medium">RAM Used</th>
                  <th className="px-6 py-3 font-medium">RAM Limit</th>
                  <th className="px-6 py-3 font-medium">PIDs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {liveStats.containers.map((c: any) => (
                  <tr key={c.container_id} className="hover:bg-accent/10 transition-colors">
                    <td className="px-6 py-3 font-mono text-xs">{c.container_name}</td>
                    <td className="px-6 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        c.status === 'running' ? 'bg-green-500/10 text-green-500' :
                        c.status === 'paused' ? 'bg-yellow-500/10 text-yellow-500' :
                        'bg-gray-500/10 text-gray-500'
                      }`}>{c.status}</span>
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-blue-500">{c.cpu_percent.toFixed(1)}%</td>
                    <td className="px-6 py-3 font-mono text-xs text-green-500">
                      {c.memory_used_bytes ? formatBytes(c.memory_used_bytes) : "—"}
                    </td>
                    <td className="px-6 py-3 font-mono text-xs">
                      {c.memory_limit_bytes ? formatBytes(c.memory_limit_bytes) : "—"}
                    </td>
                    <td className="px-6 py-3 font-mono text-xs">{c.pids || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border bg-accent/30 flex items-center gap-2">
          <Terminal size={16} className="text-muted-foreground" />
          <h3 className="font-semibold text-sm">Invocation History</h3>
        </div>
        
        {totalInvs === 0 ? (
          <div className="p-10 text-center text-muted-foreground text-sm">No invocations recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-accent/20 text-muted-foreground text-xs uppercase border-b border-border">
                <tr>
                  <th className="px-6 py-3 font-medium">Timestamp</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Latency</th>
                  <th className="px-6 py-3 font-medium">Method</th>
                  <th className="px-6 py-3 font-medium">Path</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invocations.slice().reverse().map((inv: any, idx: number) => (
                  <tr key={idx} className="hover:bg-accent/10 transition-colors">
                    <td className="px-6 py-3 text-muted-foreground font-mono text-xs">
                      {inv.created_at ? new Date(inv.created_at + 'Z').toLocaleString() : "Unknown"}
                    </td>
                    <td className="px-6 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${inv.status_code >= 200 && inv.status_code < 400 ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                        {inv.status_code}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono">{inv.latency_ms}ms</td>
                    <td className="px-6 py-3">{inv.request_method || "GET"}</td>
                    <td className="px-6 py-3 font-mono text-xs">{inv.request_path || "/"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
