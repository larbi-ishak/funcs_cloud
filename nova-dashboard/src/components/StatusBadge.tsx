"use client";

const STATUS_COLORS: Record<string, string> = {
    healthy: "bg-green-500/10 text-green-500",
    active: "bg-green-500/10 text-green-500",
    running: "bg-green-500/10 text-green-500",
    warm: "bg-blue-500/10 text-blue-500",
    claimed: "bg-purple-500/10 text-purple-500",
    paused: "bg-yellow-500/10 text-yellow-500",
    provisioning: "bg-yellow-500/10 text-yellow-500",
    faulty: "bg-red-500/10 text-red-500",
    failed: "bg-red-500/10 text-red-500",
    retired: "bg-gray-500/10 text-gray-500",
    stopped: "bg-gray-500/10 text-gray-500",
    creating: "bg-orange-500/10 text-orange-500",
    inactive: "bg-gray-500/10 text-gray-500",
    success: "bg-green-500/10 text-green-500",
    error: "bg-red-500/10 text-red-500",
    timeout: "bg-yellow-500/10 text-yellow-500",
};

interface StatusBadgeProps {
    status: string;
    className?: string;
}

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
    const colorClass = STATUS_COLORS[status] || "bg-gray-500/10 text-gray-500";
    return (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colorClass} ${className}`}>
            {status}
        </span>
    );
}