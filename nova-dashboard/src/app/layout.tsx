import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { LayoutDashboard, Rocket, Server } from "lucide-react";
import ThemeToggle from "../components/ThemeToggle";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nova Serverless Console",
  description: "Next-gen container management",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen flex bg-background`} suppressHydrationWarning>
        {/* Sidebar */}
        <aside className="w-64 border-r border-border bg-background flex flex-col">
          <div className="h-16 flex items-center px-6 border-b border-border">
            <span className="font-bold text-xl tracking-tight text-primary">NOVA<span className="text-muted-foreground">CLOUD</span></span>
          </div>
          <nav className="flex-1 py-6 px-3 space-y-1">
            <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm font-medium transition-colors">
              <LayoutDashboard size={18} />
              Dashboard
            </Link>
            <Link href="/deploy" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm font-medium transition-colors">
              <Rocket size={18} />
              Deploy Function
            </Link>
            <div className="pt-4 pb-2 px-3">
              <p className="text-xs font-semibold text-muted-foreground tracking-wider uppercase">Infrastructure</p>
            </div>
            <Link href="/workers" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm font-medium transition-colors">
              <Server size={18} />
              Worker Pool
            </Link>
          </nav>
          <div className="p-4 border-t border-border">
            <div className="text-xs text-muted-foreground">Nova Console v1.0.0</div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <header className="h-16 flex items-center px-8 border-b border-border justify-between bg-background/50 backdrop-blur-md sticky top-0 z-10">
            <div className="text-sm text-muted-foreground">Placement Service API: <span className="text-primary font-mono ml-1">{API_URL.replace(/^https?:\/\//, '')}</span></div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <div className="h-8 w-8 rounded-full bg-accent border border-border flex items-center justify-center text-xs">US</div>
            </div>
          </header>
          <div className="flex-1 overflow-auto p-8">
            <div className="max-w-6xl mx-auto">
              {children}
            </div>
          </div>
          <Toaster richColors position="top-right" />
        </main>
      </body>
    </html>
  );
}

