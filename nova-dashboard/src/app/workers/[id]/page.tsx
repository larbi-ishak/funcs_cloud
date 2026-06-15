"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Server, CheckCircle2, AlertCircle, Cpu, HardDrive,
  MemoryStick, Container, Activity, RefreshCw,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

const statusColor: Record<string, string> = {
  healthy: "text-green-500",
  faulty: "text-yellow-500",
  retired: "text-red-500",
  paused: "text-yellow-500",
  running: "text-green-500",
  creating: "text-blue-500",
  stopped: "text-muted-foreground",
  failed: "text-red-500",
};

const statusIcon: Record<string, typeof CheckCircle2> = {
  healthy: CheckCircle2,
  faulty: AlertCircle,
  retired: AlertCircle,
};

export default function WorkerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workerId = params.id as string;

  const [worker, setWorker] = useState<any>(null);
  const [containers, setContainers] = useState<any[]>([]);
  const [containerStats, setContainerStats] = useState<Record<string, any>>({});
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const [workerRes, containersRes, statsRes] = await Promise.allSettled([
        fetch(`${API_URL}/workers/${workerId}`).then((r) => r.json()),
        fetch(`${API_URL}/workers/${workerId}/containers`).then((r) => r.json()),
        fetch(`${API_URL}/workers/${workerId}/stats`).then((r) => r.json()),
      ]);

      if (workerRes.status === "fulfilled") setWorker(workerRes.value.worker);
      if (containersRes.status === "fulfilled") {
        const cData = containersRes.value;
        setContainers(cData.containers || []);
        // Also fetch per-container stats if we have the worker IP
        if (cData.worker_ip) {
          try {
            const statsRes2 = await fetch(`${API_URL}/workers/${workerId}/stats`);
            const statsData = await statsRes2.json();
            // The /stats endpoint doesn't have per-container stats, we need /container-stats from worker
            // For now we'll use the container-stats from the placement service
          } catch (_) {}
        }
      }
      if (statsRes.status === "fulfilled") setStats(statsRes.value);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 5000);
    return () => clearInterval(t);
  }, [workerId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground p-8 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !worker) {
    return (
      <div className="min-h-screen bg-background text-foreground p-8">
        <p className="text-red-500">Error: {error || "Worker not found"}</p>
        <button onClick={() => router.push("/workers")} className="mt-4 text-blue-500 hover:underline">
          ← Back to Workers
        </button>
      </div>
    );
  }

  const StatusIcon = statusIcon[worker.status] || Server;

  return (
    <div className="min-h-screen bg-background text-foreground p-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.push("/workers")}
          className="p-2 rounded-lg bg-card border border-border hover:bg-accent transition"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <Server className="w-8 h-8 text-blue-500" />
        <div>
          <h1 className="text-2xl font-bold">Worker {worker.ip}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StatusIcon className={`w-4 h-4 ${statusColor[worker.status] || "text-muted-foreground"}`} />
            <span className={`text-sm ${statusColor[worker.status] || "text-muted-foreground"}`}>
              {worker.status}
            </span>
            {worker.last_seen_at && (
              <span className="text-muted-foreground text-sm ml-2">
                Last seen: {timeAgo(worker.last_seen_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Resource Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* CPU */}
        <div className="bg-card rounded-xl p-5 border border-border">
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold">CPU</h3>
          </div>
          {stats?.cpu ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load (1min)</span>
                <span className="font-mono">{stats.cpu.load_1min.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load (5min)</span>
                <span className="font-mono">{stats.cpu.load_5min.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load (15min)</span>
                <span className="font-mono">{stats.cpu.load_15min.toFixed(2)}</span>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Unavailable</p>
          )}
        </div>

        {/* Memory */}
        <div className="bg-card rounded-xl p-5 border border-border">
          <div className="flex items-center gap-2 mb-3">
            <MemoryStick className="w-5 h-5 text-green-500" />
            <h3 className="font-semibold">Memory</h3>
          </div>
          {stats?.memory?.total_bytes ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Used</span>
                <span className="font-mono">
                  {formatBytes(stats.memory.used_bytes)} / {formatBytes(stats.memory.total_bytes)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Available</span>
                <span className="font-mono">{formatBytes(stats.memory.available_bytes)}</span>
              </div>
              <div className="mt-2">
                <div className="w-full bg-accent rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full transition-all"
                    style={{ width: `${stats.memory.used_percent}%` }}
                  />
                </div>
                <p className="text-right text-xs text-muted-foreground mt-1">{stats.memory.used_percent}%</p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Unavailable</p>
          )}
        </div>

        {/* Disk */}
        <div className="bg-card rounded-xl p-5 border border-border">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive className="w-5 h-5 text-purple-500" />
            <h3 className="font-semibold">Disk</h3>
          </div>
          {stats?.disk?.total_bytes ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Used</span>
                <span className="font-mono">
                  {formatBytes(stats.disk.used_bytes)} / {formatBytes(stats.disk.total_bytes)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Available</span>
                <span className="font-mono">{formatBytes(stats.disk.available_bytes)}</span>
              </div>
              <div className="mt-2">
                <div className="w-full bg-accent rounded-full h-2">
                  <div
                    className="bg-purple-500 h-2 rounded-full transition-all"
                    style={{ width: `${stats.disk.used_percent}%` }}
                  />
                </div>
                <p className="text-right text-xs text-muted-foreground mt-1">{stats.disk.used_percent}%</p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Unavailable</p>
          )}
        </div>
      </div>

      {/* Containers Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
          <Container className="w-5 h-5 text-blue-500" />
          <h3 className="font-semibold">Containers ({containers.length})</h3>
        </div>
        {containers.length === 0 ? (
          <p className="px-5 py-4 text-muted-foreground text-sm">No containers</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left px-5 py-3 font-medium">Name</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Live</th>
                  <th className="text-left px-5 py-3 font-medium">Function</th>
                  <th className="text-left px-5 py-3 font-medium">Port</th>
                  <th className="text-left px-5 py-3 font-medium">IP</th>
                  <th className="text-left px-5 py-3 font-medium">CPU</th>
                  <th className="text-left px-5 py-3 font-medium">RAM</th>
                  <th className="text-left px-5 py-3 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c: any) => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-accent/20">
                    <td className="px-5 py-3 font-mono text-xs">{c.container_name}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center gap-1 ${statusColor[c.status] || "text-muted-foreground"}`}>
                        <Activity className="w-3 h-3" />
                        {c.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {c.live_status === "not_found" ? (
                        <span className="text-red-500 text-xs">missing</span>
                      ) : (
                        <span className="text-foreground text-xs">{c.live_status}</span>
                      )}
                    </td>
                    <td className="px-5 py-3">{c.function_name || "—"}</td>
                    <td className="px-5 py-3 font-mono text-xs">{c.host_port}</td>
                    <td className="px-5 py-3 font-mono text-xs">{c.container_ip || "—"}</td>
                    <td className="px-5 py-3 font-mono text-xs text-blue-500">
                      {c.cpu_percent !== undefined ? `${c.cpu_percent.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-green-500">
                      {c.memory_used_bytes ? `${formatBytes(c.memory_used_bytes)}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">
                      {c.started_at ? timeAgo(c.started_at) : "—"}
                    </td>
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