"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Activity, Clock, Zap, Database, Cpu } from "lucide-react";

const METRICS_URL = process.env.NEXT_PUBLIC_METRICS_URL || "http://localhost:3003";

interface MetricGroup {
  name: string;
  help: string;
  type: string;
  values: { labels: Record<string, string>; value: number }[];
}

function parsePrometheusMetrics(text: string): MetricGroup[] {
  const groups: MetricGroup[] = [];
  const lines = text.split("\n");
  let current: MetricGroup | null = null;

  for (const line of lines) {
    if (line.startsWith("# HELP ")) {
      const match = line.match(/^# HELP (\S+) (.+)$/);
      if (match) {
        current = { name: match[1], help: match[2], type: "", values: [] };
        groups.push(current);
      }
    } else if (line.startsWith("# TYPE ")) {
      const match = line.match(/^# TYPE (\S+) (\S+)$/);
      if (match && current && current.name === match[1]) {
        current.type = match[2];
      }
    } else if (line.trim() && current) {
      const match = line.match(/^(\S+?)(?:\{(.+?)\})?\s+([\d.e+-]+)$/);
      if (match) {
        const labels: Record<string, string> = {};
        if (match[2]) {
          for (const pair of match[2].split(",")) {
            const [k, v] = pair.split("=");
            labels[k] = v.replace(/"/g, "");
          }
        }
        current.values.push({ labels, value: parseFloat(match[3]) });
      }
    }
  }
  return groups;
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<MetricGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchMetrics = async () => {
    try {
      const res = await fetch(`${METRICS_URL}/metrics`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setMetrics(parsePrometheusMetrics(text));
      setError(null);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const t = setInterval(fetchMetrics, 10000);
    return () => clearInterval(t);
  }, []);

  const findMetric = (name: string) => metrics.find(m => m.name === name);
  const novaRequestDuration = findMetric("nova_request_duration_seconds");
  const novaCacheHits = findMetric("nova_cache_hits_total");
  const novaWarmPool = findMetric("nova_warm_pool_size");
  const novaRateLimited = findMetric("nova_rate_limited_total");

  // Process request duration into summary
  const durationBuckets = novaRequestDuration?.values.filter(v => v.labels.le) || [];
  const durationSum = novaRequestDuration?.values.find(v => !v.labels.le && !Object.keys(v.labels).length)?.value || 0;
  const durationCount = novaRequestDuration?.values.find(v => v.labels.le === "+Inf")?.value || 0;
  const avgLatency = durationCount > 0 ? (durationSum / durationCount * 1000).toFixed(1) : "—";

  // Process cache hits
  const fnCacheHits = novaCacheHits?.values.find(v => v.labels.type === "fn")?.value || 0;
  const ctCacheHits = novaCacheHits?.values.find(v => v.labels.type === "ct")?.value || 0;

  // Process rate limits
  const ipRateLimited = novaRateLimited?.values.find(v => v.labels.limiter === "ip")?.value || 0;
  const fnRateLimited = novaRateLimited?.values.find(v => v.labels.limiter === "function")?.value || 0;

  // Process Node.js metrics
  const processUptime = findMetric("process_uptime_seconds")?.values[0]?.value || 0;
  const processMemRss = findMetric("process_resident_memory_bytes")?.values[0]?.value || 0;
  const nodeJsHeapUsed = findMetric("nodejs_heap_size_used_bytes")?.values[0]?.value || 0;
  const nodeJsHeapTotal = findMetric("nodejs_heap_size_total_bytes")?.values[0]?.value || 0;
  const activeHandles = findMetric("nodejs_active_handles_total")?.values[0]?.value || 0;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
          <p className="text-muted-foreground mt-1">Gateway performance and observability metrics from Prometheus endpoint.</p>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <RefreshCw size={12} className="animate-spin" />
          Auto-refresh every 10s{lastRefresh && <> · Last: <span suppressHydrationWarning>{lastRefresh.toLocaleTimeString()}</span></>}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-500 text-sm">
          Failed to fetch metrics from {METRICS_URL}/metrics: {error}
        </div>
      )}

      {loading ? (
        <div className="h-64 flex items-center justify-center border border-border rounded-lg border-dashed">
          <RefreshCw className="animate-spin text-muted-foreground mr-2" />
          <span className="text-muted-foreground">Loading metrics...</span>
        </div>
      ) : (
        <>
          {/* Key Metrics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard icon={<Clock size={18} />} title="Avg Latency" value={`${avgLatency} ms`} subtitle="Request duration" color="blue" />
            <MetricCard icon={<Zap size={18} />} title="Total Requests" value={durationCount.toLocaleString()} subtitle="Since startup" color="green" />
            <MetricCard icon={<Database size={18} />} title="Cache Hits" value={`${fnCacheHits + ctCacheHits}`} subtitle={`fn: ${fnCacheHits} · ct: ${ctCacheHits}`} color="purple" />
            <MetricCard icon={<Activity size={18} />} title="Rate Limited" value={`${ipRateLimited + fnRateLimited}`} subtitle={`ip: ${ipRateLimited} · fn: ${fnRateLimited}`} color="red" />
          </div>

          {/* System Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="border border-border rounded-xl bg-card p-5 shadow-sm">
              <h3 className="font-semibold text-sm mb-4 flex items-center gap-2"><Cpu size={16} /> Process</h3>
              <div className="space-y-3 text-sm">
                <MetricRow label="Uptime" value={formatUptime(processUptime)} />
                <MetricRow label="Memory RSS" value={formatBytes(processMemRss)} />
                <MetricRow label="Heap Used" value={formatBytes(nodeJsHeapUsed)} />
                <MetricRow label="Heap Total" value={formatBytes(nodeJsHeapTotal)} />
                <MetricRow label="Heap Usage" value={`${nodeJsHeapTotal > 0 ? (nodeJsHeapUsed / nodeJsHeapTotal * 100).toFixed(1) : 0}%`} />
                <MetricRow label="Active Handles" value={activeHandles.toString()} />
              </div>
            </div>

            {/* Request Duration Histogram */}
            <div className="border border-border rounded-xl bg-card p-5 shadow-sm">
              <h3 className="font-semibold text-sm mb-4 flex items-center gap-2"><Clock size={16} /> Latency Distribution</h3>
              {durationBuckets.length > 0 ? (
                <div className="space-y-2">
                  {durationBuckets
                    .filter(b => b.labels.le !== "+Inf")
                    .map(b => {
                      const maxMs = parseFloat(b.labels.le) * 1000;
                      const maxPct = durationCount > 0 ? (b.value / durationCount * 100) : 0;
                      return (
                        <div key={b.labels.le} className="flex items-center gap-3 text-xs">
                          <span className="w-16 text-right text-muted-foreground font-mono">{maxMs}ms</span>
                          <div className="flex-1 h-4 bg-accent rounded overflow-hidden">
                            <div className="h-full bg-blue-500/70 transition-all" style={{ width: `${maxPct}%` }} />
                          </div>
                          <span className="w-12 text-right font-mono">{maxPct.toFixed(0)}%</span>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No request data yet</p>
              )}
            </div>
          </div>

          {/* Warm Pool */}
          {novaWarmPool && novaWarmPool.values.length > 0 && (
            <div className="border border-border rounded-xl bg-card p-5 shadow-sm">
              <h3 className="font-semibold text-sm mb-4">Warm Pool Size</h3>
              <div className="text-3xl font-bold">{novaWarmPool.values[0].value}</div>
            </div>
          )}

          {/* Raw Metrics (collapsible) */}
          <details className="border border-border rounded-xl bg-card shadow-sm">
            <summary className="p-4 cursor-pointer text-sm font-medium hover:bg-accent/30 rounded-t-xl">
              Raw Prometheus Metrics ({metrics.length} metrics)
            </summary>
            <pre className="p-4 text-xs font-mono text-muted-foreground overflow-x-auto border-t border-border max-h-96 overflow-y-auto">
              {metrics.map(m => `# HELP ${m.name} ${m.help}\n# TYPE ${m.name} ${m.type}\n${m.values.map(v => {
                const labels = Object.entries(v.labels).map(([k, val]) => `${k}="${val}"`).join(",");
                return `${m.name}{${labels}} ${v.value}`;
              }).join("\n")}\n`).join("\n")}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function MetricCard({ icon, title, value, subtitle, color }: {
  icon: React.ReactNode; title: string; value: string; subtitle: string; color: string;
}) {
  const colors: Record<string, string> = {
    blue: "bg-blue-500/10 text-blue-500",
    green: "bg-green-500/10 text-green-500",
    purple: "bg-purple-500/10 text-purple-500",
    red: "bg-red-500/10 text-red-500",
  };
  return (
    <div className="border border-border rounded-xl bg-card p-5 shadow-sm">
      <div className={`h-8 w-8 rounded-md ${colors[color]} flex items-center justify-center mb-3`}>
        {icon}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{title} · {subtitle}</div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}