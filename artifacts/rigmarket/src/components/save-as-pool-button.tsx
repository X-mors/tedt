import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateMyPool,
  getListMyPoolsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { BookmarkPlus } from "lucide-react";

export function SaveAsPoolButton({
  poolUrl,
  worker,
  password,
  size = "sm",
  variant = "outline",
  className = "",
}: {
  poolUrl: string;
  worker: string;
  password: string;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createPool = useCreateMyPool();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");

  const trimmedUrl = poolUrl.trim();
  const trimmedWorker = worker.trim();
  const ready = trimmedUrl.length > 0 && trimmedWorker.length > 0;

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      const host = trimmedUrl
        .replace(/^stratum\+(tcp|ssl):\/\//i, "")
        .split(":")[0]
        ?.split("/")[0];
      setLabel(host ? `${host}` : "");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      toast({ title: "Please give this pool a label", variant: "destructive" });
      return;
    }
    if (!ready) {
      toast({
        title: "Pool URL and worker are required",
        variant: "destructive",
      });
      return;
    }
    createPool.mutate(
      {
        data: {
          label: label.trim(),
          poolUrl: trimmedUrl,
          worker: trimmedWorker,
          password: password || "x",
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Pool saved",
            description: `"${label.trim()}" added to your pools.`,
          });
          queryClient.invalidateQueries({ queryKey: getListMyPoolsQueryKey() });
          setOpen(false);
          setLabel("");
        },
        onError: (err) =>
          toast({
            title: "Save failed",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          disabled={!ready}
          className={`font-mono text-xs gap-1.5 ${className}`}
          title={
            ready
              ? "Save these pool credentials to your reusable list"
              : "Fill the pool URL and worker first"
          }
        >
          <BookmarkPlus className="w-3.5 h-3.5" /> Save as Pool
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkPlus className="w-4 h-4 text-primary" /> Save Pool to My
            List
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Give this pool a friendly name so you can reuse it on future rentals
            and rigs without re-typing.
          </p>
          <div className="space-y-2">
            <Label htmlFor="pool-label">Label</Label>
            <Input
              id="pool-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. F2Pool BTC"
              className="font-mono text-sm bg-background"
              autoFocus
            />
          </div>
          <div className="rounded-md border border-border/50 bg-muted/20 p-3 space-y-1.5 text-xs font-mono break-all">
            <div>
              <span className="text-muted-foreground">URL: </span>
              {trimmedUrl}
            </div>
            <div>
              <span className="text-muted-foreground">Worker: </span>
              {trimmedWorker}
            </div>
          </div>
          <Button
            type="submit"
            disabled={createPool.isPending}
            className="w-full font-mono text-xs"
          >
            {createPool.isPending ? "SAVING..." : "SAVE_POOL"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
