"use client";

interface MetricCardProps {
    label: string;
    value: string | number;
    unit?: string;
    sublabel?: string;
    className?: string;
}

export function MetricCard({ label, value, unit, sublabel, className = "" }: MetricCardProps) {
    return (
        <div className={`border border-border rounded-lg bg-card p-4 ${className}`}>
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className="text-2xl font-bold">
                {value}
                {unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
            </p>
            {sublabel && <p className="text-xs text-muted-foreground mt-1">{sublabel}</p>}
        </div>
    );
}