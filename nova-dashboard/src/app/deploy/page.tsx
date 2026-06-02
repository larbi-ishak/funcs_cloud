"use client";

import { useState, useRef, useEffect } from "react";
import { UploadCloud, Rocket, Terminal as TerminalIcon, File as FileIcon, Folder, Trash2 } from "lucide-react";

// Helper component for recursive file tree rendering
const FileTreeNode = ({ name, node }: { name: string; node: any }) => {
  if (node.__dir) {
    return (
      <div className="pl-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
          <Folder size={14} className="text-blue-400" />
          <span className="font-medium">{name}/</span>
        </div>
        <div className="border-l border-border/50 ml-2 pl-2">
          {Object.entries(node.__children)
            .sort(([a, aVal]: any, [b, bVal]: any) => {
              return (aVal.__dir ? 0 : 1) - (bVal.__dir ? 0 : 1) || a.localeCompare(b);
            })
            .map(([childName, childNode]) => (
              <FileTreeNode key={childName} name={childName} node={childNode} />
            ))}
        </div>
      </div>
    );
  }

  // File node
  const ext = name.split('.').pop()?.toLowerCase();
  let iconColor = "text-muted-foreground";
  if (ext === 'py') iconColor = "text-yellow-500";
  else if (ext === 'js' || ext === 'ts') iconColor = "text-yellow-400";
  else if (ext === 'json') iconColor = "text-green-400";
  
  const sizeKb = (node.__obj.size / 1024).toFixed(1);

  return (
    <div className="pl-4 flex items-center justify-between text-sm py-1 group hover:bg-accent/30 rounded px-2">
      <div className="flex items-center gap-2">
        <FileIcon size={14} className={iconColor} />
        <span>{name}</span>
      </div>
      <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
        {sizeKb} KB
      </span>
    </div>
  );
};

export default function DeployPage() {
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [availableEntries, setAvailableEntries] = useState<string[]>([]);
  const [availableReqs, setAvailableReqs] = useState<string[]>([]);
  const [fileTree, setFileTree] = useState<any>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState({
    name: "",
    region: "us-east-1",
    runtime: "python",
    entry_point: "",
    requirements_file: "",
    memory_limit: "512",
    cpu_limit: "1.0",
    storage_limit: "3072",
    warm_count: 1,
    max_containers: 10,
    env_vars: "",
  });

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return alert("Select files to upload");
    if (!formData.name || !formData.entry_point) return alert("Missing required fields");

    setLoading(true);
    setLogs([]);

    const data = new FormData();
    data.append("name", formData.name);
    data.append("region", formData.region);
    data.append("runtime", formData.runtime);
    data.append("entry_point", formData.entry_point);
    if (formData.requirements_file) data.append("requirements_file", formData.requirements_file);
    data.append("memory_limit", formData.memory_limit);
    data.append("cpu_limit", formData.cpu_limit);
    data.append("storage_limit", formData.storage_limit);
    data.append("warm_count", formData.warm_count.toString());
    data.append("max_containers", formData.max_containers.toString());
    
    if (formData.env_vars) {
      try {
        const parsed = JSON.parse(formData.env_vars);
        data.append("env_vars", JSON.stringify(parsed));
      } catch {
        alert("Environment variables must be valid JSON");
        setLoading(false);
        return;
      }
    }

    files.forEach(f => {
      const rel = (f as any).webkitRelativePath || f.name;
      const withoutRoot = rel.split('/').slice(1).join('/') || f.name;
      data.append("file_paths", withoutRoot);
      data.append("files", f, withoutRoot);
    });

    try {
      const response = await fetch("http://localhost:3002/functions/deploy", {
        method: "POST",
        body: data,
      });

      if (!response.ok || !response.body) {
        throw new Error("Deployment request failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.substring(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const parsed = JSON.parse(line.substring(6));
              if (eventType === "log") {
                setLogs(prev => [...prev, parsed.message || JSON.stringify(parsed)]);
              } else if (eventType === "done") {
                if (parsed.success) {
                  setLogs(prev => [...prev, `[SUCCESS] Deployed! ${parsed.warm_containers} warm containers ready.`]);
                } else {
                  setLogs(prev => [...prev, `[ERROR] ${parsed.error}`]);
                }
              }
            } catch {}
            eventType = null;
          }
        }
      }
    } catch (e: any) {
      setLogs(prev => [...prev, `[ERROR] ${e.message}`]);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files).filter(f => {
        const path = (f as any).webkitRelativePath || f.name;
        return !path.split('/').some(p => p.startsWith('.') || p === '__pycache__' || p === 'node_modules');
      });
      setFiles(selected);

      // Populate dropdowns
      const allPaths = selected.map(f => {
        const parts = ((f as any).webkitRelativePath || f.name).split('/');
        return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      });

      // Build file tree
      const root: any = { __dir: true, __children: {} };
      for (const f of selected) {
        const parts = ((f as any).webkitRelativePath || f.name).split('/');
        let node = root.__children;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!node[parts[i]]) node[parts[i]] = { __dir: true, __children: {} };
          node = node[parts[i]].__children;
        }
        node[parts[parts.length - 1]] = { __file: true, __obj: f };
      }
      setFileTree(root.__children);

      const entries = allPaths.filter(p => /\.(py|js|ts|php|rb|go|jar|dll)$/.test(p));
      const reqs = allPaths.filter(p => /^(requirements.*\.txt|requirements\.in|package\.json|composer\.json|Gemfile|go\.mod)$/.test(p.split('/').pop() || ''));

      setAvailableEntries(entries);
      setAvailableReqs(reqs);

      let newEntry = "";
      let newReq = "";
      
      const defaultEntries = ['handler.py','main.py','index.py','handler.js','index.js','main.go','index.php','app.rb'];
      for (const e of entries) {
        if (defaultEntries.includes(e.split('/').pop() || '')) {
          newEntry = e;
          break;
        }
      }

      for (const r of reqs) {
        if (r.split('/').pop() === 'requirements.txt') {
          newReq = r;
          break;
        }
      }

      setFormData(prev => ({
        ...prev,
        entry_point: newEntry || (entries.length > 0 ? entries[0] : ""),
        requirements_file: newReq || (reqs.length > 0 ? reqs[0] : ""),
      }));
    }
  };

  const clearFiles = () => {
    setFiles([]);
    setFileTree(null);
    setAvailableEntries([]);
    setAvailableReqs([]);
    setFormData(prev => ({ ...prev, entry_point: "", requirements_file: "" }));
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Deploy Function</h1>
        <p className="text-muted-foreground mt-1">Upload your code and configure infrastructure limits.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <form onSubmit={handleDeploy} className="space-y-6">
          <div className="bg-card border border-border p-6 rounded-xl shadow-sm space-y-4">
            
            <div>
              <label className="block text-sm font-medium mb-2">Function Name</label>
              <input 
                type="text" 
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" 
                placeholder="my-cool-api"
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Runtime</label>
                <select 
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none"
                  value={formData.runtime}
                  onChange={e => setFormData({...formData, runtime: e.target.value})}
                >
                  <option value="python">Python 3.11</option>
                  <option value="nodejs">Node.js 20</option>
                  <option value="php">PHP 8.2</option>
                  <option value="ruby">Ruby 3.2</option>
                  <option value="golang">Go 1.21</option>
                  <option value="java">Java 17</option>
                  <option value="dotnet">.NET 8.0</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Entry Point</label>
                <select 
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none"
                  value={formData.entry_point}
                  onChange={e => setFormData({...formData, entry_point: e.target.value})}
                >
                  <option value="">— select entry point —</option>
                  {availableEntries.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Requirements</label>
                <select 
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none"
                  value={formData.requirements_file}
                  onChange={e => setFormData({...formData, requirements_file: e.target.value})}
                >
                  <option value="">— None (no dependencies) —</option>
                  {availableReqs.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">Source Code (Directory)</label>
                {files.length > 0 && (
                  <button type="button" onClick={clearFiles} className="text-xs text-red-500 hover:text-red-400 flex items-center gap-1">
                    <Trash2 size={12} /> Clear
                  </button>
                )}
              </div>

              {files.length === 0 ? (
                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center hover:bg-accent/50 transition-colors cursor-pointer relative">
                  <input 
                    type="file" 
                    {...{ webkitdirectory: "", directory: "" } as any}
                    multiple
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <UploadCloud className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">Click to select folder</p>
                  <p className="text-xs text-muted-foreground mt-1">Includes all subdirectories</p>
                </div>
              ) : (
                <div className="border border-border rounded-lg bg-[#0c0c0c] p-4 max-h-[250px] overflow-y-auto font-mono">
                  {fileTree && Object.entries(fileTree)
                    .sort(([a, aVal]: any, [b, bVal]: any) => {
                      return (aVal.__dir ? 0 : 1) - (bVal.__dir ? 0 : 1) || a.localeCompare(b);
                    })
                    .map(([name, node]) => (
                      <FileTreeNode key={name} name={name} node={node} />
                    ))}
                </div>
              )}
            </div>

            <hr className="border-border my-6" />

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Memory</label>
                <select className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm" value={formData.memory_limit} onChange={e => setFormData({...formData, memory_limit: e.target.value})}>
                  <option value="128">128 MB</option>
                  <option value="256">256 MB</option>
                  <option value="512">512 MB</option>
                  <option value="1024">1 GB</option>
                  <option value="2048">2 GB</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">vCPU</label>
                <select className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm" value={formData.cpu_limit} onChange={e => setFormData({...formData, cpu_limit: e.target.value})}>
                  <option value="0.5">0.5</option>
                  <option value="1.0">1.0</option>
                  <option value="2.0">2.0</option>
                  <option value="4.0">4.0</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Storage</label>
                <select className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm" value={formData.storage_limit} onChange={e => setFormData({...formData, storage_limit: e.target.value})}>
                  <option value="512">512 MB</option>
                  <option value="1024">1 GB</option>
                  <option value="3072">3 GB</option>
                  <option value="10240">10 GB</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Min Warm Containers</label>
                <input type="number" min="0" max="20" className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm" value={formData.warm_count} onChange={e => setFormData({...formData, warm_count: parseInt(e.target.value)})} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Max Scaling Limit</label>
                <input type="number" min="1" max="50" className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm" value={formData.max_containers} onChange={e => setFormData({...formData, max_containers: parseInt(e.target.value)})} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Environment Variables (JSON)</label>
              <textarea 
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none" 
                rows={3}
                placeholder='{"API_KEY": "secret"}'
                value={formData.env_vars}
                onChange={e => setFormData({...formData, env_vars: e.target.value})}
              />
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-foreground text-background py-3 rounded-md font-medium hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? <Rocket className="animate-bounce" size={18} /> : <Rocket size={18} />}
              {loading ? "Deploying..." : "Deploy & Warm"}
            </button>
          </div>
        </form>

        <div className="bg-[#0c0c0c] border border-border rounded-xl shadow-sm flex flex-col h-[700px] font-mono text-sm overflow-hidden">
          <div className="h-10 bg-accent/20 border-b border-border flex items-center px-4 gap-2 text-muted-foreground">
            <TerminalIcon size={14} />
            <span>Build Logs</span>
          </div>
          <div className="flex-1 p-4 overflow-y-auto space-y-1">
            {logs.length === 0 ? (
              <div className="text-muted-foreground/50 h-full flex items-center justify-center">Waiting for deployment...</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="text-gray-300">
                  <span className="text-blue-400 mr-2">❯</span> {log}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
