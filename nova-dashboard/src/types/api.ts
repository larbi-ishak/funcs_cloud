/**
 * API response types for Nova Dashboard.
 *
 * PostgreSQL-ready: IDs are `string` (works for both current text IDs and future UUIDs).
 * Timestamps are `string` (ISO format, works for both SQLite and PG NOW()).
 */

// ── Core Entities ─────────────────────────────────────────────────────────────

export interface NovaFunction {
    id: string;
    name: string;
    image: string;
    status: string;          // 'active' | 'inactive' | etc.
    memory_limit: number;    // MB
    cpu_limit: number;       // cores
    storage_limit: number;   // MB
    max_containers: number;
    warm_count: number;
    claimed_count: number;
    created_at?: string;
    env_vars?: Record<string, string>;
}

export interface Worker {
    id: string;
    ip: string;
    status: string;          // 'healthy' | 'faulty' | 'retired' | 'provisioning'
    username: string;
    ssh_port: number;
    gcp_instance_name?: string;
    gcp_zone?: string;
    created_at?: string;
    last_health_check?: string;
    container_count?: number;
    max_containers?: number;
    consecutive_failures?: number;
    total_memory_mb?: number;
}

export interface Container {
    id: string;
    worker_id: string;
    container_name: string;
    image: string;
    runtime: string;
    container_ip: string | null;
    host_port: number;
    agent_port: number;
    status: string;          // 'running' | 'paused' | 'creating' | 'failed' | 'stopped'
    function_id: string | null;
    started_at: string | null;
    metadata?: string;       // JSON string
}

export interface WarmPoolEntry {
    id: string;
    function_id: string;
    container_id: string;
    worker_id: string;
    status: string;          // 'warm' | 'claimed'
    created_at?: string;
}

export interface Invocation {
    id: string;
    function_id: string;
    container_id: string | null;
    status: string;          // 'success' | 'error' | 'timeout'
    duration_ms: number | null;
    status_code: number | null;
    created_at: string;
}

export interface Event {
    id: string;
    worker_id: string | null;
    event_type: string;
    message: string;
    created_at: string;
}

// ── API Response Wrappers ─────────────────────────────────────────────────────

export interface FunctionsResponse {
    functions: NovaFunction[];
}

export interface WorkersResponse {
    workers: Worker[];
}

export interface WorkerDetailResponse {
    worker: Worker;
    containers: Container[];
    events: Event[];
}

export interface FunctionDetailResponse {
    fn: NovaFunction;
    containers: Container[];
    invocations: Invocation[];
    warmPool: WarmPoolEntry[];
}

export interface ContainersResponse {
    containers: Container[];
}

export interface WarmPoolResponse {
    pool: WarmPoolEntry[];
}

export interface ReplenishResponse {
    success: boolean;
    message?: string;
}

export interface DeleteResponse {
    success: boolean;
    message?: string;
}

// ── Deploy SSE Events ────────────────────────────────────────────────────────

export interface DeployLogEvent {
    type: 'log' | 'error' | 'done';
    line?: string;
    message?: string;
    function_id?: string;
}

// ── Metrics (Prometheus) ─────────────────────────────────────────────────────

export interface MetricsSummary {
    avgLatency: number;
    totalRequests: number;
    cacheHits: number;
    rateLimited: number;
    uptime: number;
    memoryUsed: number;
    heapUsed: number;
    warmPoolSize: number;
}

// ── Auto-Scaling ─────────────────────────────────────────────────────────────

export interface ScaleStatus {
    triggered: boolean;
    reason: string;
    metrics?: {
        totalWorkers: number;
        healthyWorkers: number;
        clusterCapacity: number;
        activeContainers: number;
        utilisation: number;
        thresholdToScaleOut: number;
        maxWorkers: number;
        scalingInProgress: boolean;
        lastScaleOutAt: number | null;
    };
}