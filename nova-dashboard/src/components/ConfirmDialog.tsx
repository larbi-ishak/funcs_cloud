"use client";

import { useState } from "react";

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: "danger" | "warning" | "default";
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmDialog({
    open, title, message, confirmLabel = "Confirm",
    variant = "default", onConfirm, onCancel,
}: ConfirmDialogProps) {
    if (!open) return null;

    const btnClass = variant === "danger"
        ? "bg-red-500 hover:bg-red-600 text-white"
        : variant === "warning"
        ? "bg-yellow-500 hover:bg-yellow-600 text-white"
        : "bg-primary hover:bg-primary/90 text-primary-foreground";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
            <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-semibold mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground mb-6 whitespace-pre-line">{message}</p>
                <div className="flex justify-end gap-3">
                    <button onClick={onCancel} className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors">
                        Cancel
                    </button>
                    <button onClick={onConfirm} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${btnClass}`}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Hook for simpler confirm dialog usage (replaces window.confirm) */
export function useConfirm() {
    const [state, setState] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void }>({
        open: false, title: "", message: "", onConfirm: () => {},
    });

    const confirm = (title: string, message: string): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            setState({
                open: true,
                title,
                message,
                onConfirm: () => { setState(s => ({ ...s, open: false })); resolve(true); },
            });
        });
    };

    const cancel = () => { setState(s => ({ ...s, open: false })); };

    return { confirm, cancel, dialogProps: state };
}