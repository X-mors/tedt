import { useState } from "react";
import {
  useListMyPools,
  useCreateMyPool,
  useUpdateMyPool,
  useDeleteMyPool,
  getListMyPoolsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Waves, Plus, Trash2, Pencil } from "lucide-react";

interface PoolFormState {
  label: string;
  poolUrl: string;
  worker: string;
  password: string;
}

const EMPTY: PoolFormState = { label: "", poolUrl: "", worker: "", password: "x" };

export default function MyPoolsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: pools, isLoading } = useListMyPools();
  const createPool = useCreateMyPool();
  const updatePool = useUpdateMyPool();
  const deletePool = useDeleteMyPool();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PoolFormState>(EMPTY);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListMyPoolsQueryKey() });

  const handleOpenCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    setOpen(true);
  };

  const handleOpenEdit = (id: number) => {
    const p = pools?.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    setForm({ label: p.label, poolUrl: p.poolUrl, worker: p.worker, password: p.password });
    setOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = {
      label: form.label.trim(),
      poolUrl: form.poolUrl.trim(),
      worker: form.worker.trim(),
      password: form.password || "x",
    };
    if (!trimmed.label || !trimmed.poolUrl || !trimmed.worker) {
      toast({ title: "Label, pool URL and worker are required", variant: "destructive" });
      return;
    }
    const onError = (err: Error) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" });

    if (editingId == null) {
      createPool.mutate(
        { data: trimmed },
        {
          onSuccess: () => {
            toast({ title: "Pool saved" });
            refresh();
            setOpen(false);
          },
          onError,
        },
      );
    } else {
      updatePool.mutate(
        { id: editingId, data: trimmed },
        {
          onSuccess: () => {
            toast({ title: "Pool updated" });
            refresh();
            setOpen(false);
          },
          onError,
        },
      );
    }
  };

  const handleDelete = (id: number, label: string) => {
    if (!confirm(`Delete saved pool "${label}"?`)) return;
    deletePool.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Pool removed" });
          refresh();
        },
        onError: (err) =>
          toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  return (
    <div className="container py-8 px-4 max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Waves className="w-6 h-6 text-primary" /> Saved Pools
          </h1>
          <p className="text-muted-foreground mt-1">
            Save mining pool credentials once and reuse them for any rental or rig fallback.
            Pools are private to your account.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={handleOpenCreate} className="font-mono text-xs gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4" /> ADD_POOL
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingId == null ? "Add saved pool" : "Edit saved pool"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="pool-label">Label</Label>
                <Input
                  id="pool-label"
                  placeholder="e.g. F2Pool BTC"
                  value={form.label}
                  onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
                  className="font-mono text-sm bg-background"
                  maxLength={64}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pool-url">Stratum URL</Label>
                <Input
                  id="pool-url"
                  placeholder="stratum+tcp://btc.f2pool.com:3333"
                  value={form.poolUrl}
                  onChange={(e) => setForm((p) => ({ ...p, poolUrl: e.target.value }))}
                  className="font-mono text-sm bg-background"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pool-worker">Worker</Label>
                <Input
                  id="pool-worker"
                  placeholder="walletAddress.workerName"
                  value={form.worker}
                  onChange={(e) => setForm((p) => ({ ...p, worker: e.target.value }))}
                  className="font-mono text-sm bg-background"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pool-password">Password</Label>
                <Input
                  id="pool-password"
                  placeholder="x"
                  value={form.password}
                  onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                  className="font-mono text-sm bg-background"
                />
              </div>
              <Button
                type="submit"
                className="w-full font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={createPool.isPending || updatePool.isPending}
              >
                {createPool.isPending || updatePool.isPending ? "SAVING..." : editingId == null ? "SAVE_POOL" : "UPDATE_POOL"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground font-mono text-sm">LOADING_POOLS...</div>
      ) : !pools || pools.length === 0 ? (
        <Card className="bg-card/50 border-dashed border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground space-y-2">
            <Waves className="w-10 h-10 mx-auto opacity-40" />
            <p className="text-sm">No saved pools yet</p>
            <p className="text-xs">Add a pool here to prefill it on rentals and rig fallback settings.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {pools.map((p) => (
            <Card key={p.id} className="bg-card/50 border-border/50">
              <CardHeader className="pb-2 flex-row items-center justify-between">
                <CardTitle className="text-base">{p.label}</CardTitle>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleOpenEdit(p.id)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(p.id, p.label)}
                    disabled={deletePool.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs font-mono text-muted-foreground">
                <div className="flex gap-2"><span className="w-16 opacity-60">URL</span><span className="break-all">{p.poolUrl}</span></div>
                <div className="flex gap-2"><span className="w-16 opacity-60">WORKER</span><span className="break-all">{p.worker}</span></div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
