import { useEffect } from "react";
import { useParams, Link } from "wouter";
import { useGetRental, useGetRentalStats, useGetRentalLive, getGetRentalLiveQueryKey, getGetRentalStatsQueryKey, useCancelRental, useCreateRentalReview, getGetRentalQueryKey, useSwitchRentalPool, useListMyPools, useGetMe, useExtendRental } from "@workspace/api-client-react";
import { SaveAsPoolButton } from "@/components/save-as-pool-button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Repeat } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatSeconds } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, CheckCircle2, Wifi, WifiOff, BarChart2, ShieldAlert, Clock } from "lucide-react";
import { Area, AreaChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { Star } from "lucide-react";

function SwitchPoolDialog({
  rentalId,
  currentUrl,
  currentWorker,
  currentPassword,
}: {
  rentalId: number;
  currentUrl: string;
  currentWorker: string;
  currentPassword: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: savedPools } = useListMyPools();
  const switchPool = useSwitchRentalPool();
  const [open, setOpen] = useState(false);
  const [poolUrl, setPoolUrl] = useState(currentUrl);
  const [poolWorker, setPoolWorker] = useState(currentWorker);
  const [poolPassword, setPoolPassword] = useState(currentPassword);

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPoolUrl(currentUrl);
      setPoolWorker(currentWorker);
      setPoolPassword(currentPassword);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = poolUrl.trim();
    const worker = poolWorker.trim();
    if (!url || !worker) {
      toast({ title: "Pool URL and worker are required", variant: "destructive" });
      return;
    }
    switchPool.mutate(
      { id: rentalId, data: { poolUrl: url, poolWorker: worker, poolPassword: poolPassword || "x" } },
      {
        onSuccess: () => {
          toast({ title: "Pool switched", description: "Hashrate is being redirected without dropping the session." });
          queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
          queryClient.invalidateQueries({ queryKey: getGetRentalLiveQueryKey(rentalId) });
          setOpen(false);
        },
        onError: (err) =>
          toast({ title: "Switch failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="font-mono text-xs gap-1.5 h-7">
          <Repeat className="w-3 h-3" /> SWITCH
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="w-4 h-4 text-cyan-400" /> Switch destination pool live
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            The rental keeps running — the miner reconnects within seconds and resumes hashing into the new pool. No need to cancel.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Use a Saved Pool</Label>
              <Link
                href="/pools"
                className="text-xs text-primary hover:underline font-mono"
              >
                Manage saved pools →
              </Link>
            </div>
            {savedPools && savedPools.length > 0 ? (
              <Select
                value=""
                onValueChange={(value) => {
                  const p = savedPools.find((x) => String(x.id) === value);
                  if (p) {
                    setPoolUrl(p.poolUrl);
                    setPoolWorker(p.worker);
                    setPoolPassword(p.password);
                  }
                }}
              >
                <SelectTrigger className="font-mono text-sm bg-background">
                  <SelectValue placeholder="Pick from your saved pools…" />
                </SelectTrigger>
                <SelectContent>
                  {savedPools.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No saved pools yet. Add one to switch in one click next time.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="switch-pool-url">Stratum URL</Label>
            <Input
              id="switch-pool-url"
              value={poolUrl}
              onChange={(e) => setPoolUrl(e.target.value)}
              className="font-mono text-sm bg-background"
              placeholder="stratum+tcp://pool.example.com:3333"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="switch-pool-worker">Worker</Label>
            <Input
              id="switch-pool-worker"
              value={poolWorker}
              onChange={(e) => setPoolWorker(e.target.value)}
              className="font-mono text-sm bg-background"
              placeholder="walletAddress.workerName"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="switch-pool-password">Password</Label>
            <Input
              id="switch-pool-password"
              value={poolPassword}
              onChange={(e) => setPoolPassword(e.target.value)}
              className="font-mono text-sm bg-background"
              placeholder="x"
            />
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
            <SaveAsPoolButton
              poolUrl={poolUrl}
              worker={poolWorker}
              password={poolPassword}
            />
            <Button
              type="submit"
              className="font-mono text-xs bg-cyan-500 hover:bg-cyan-500/90 text-white flex-1 min-w-[140px]"
              disabled={switchPool.isPending}
            >
              {switchPool.isPending ? "SWITCHING..." : "SWITCH_POOL"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExtendRentalDialog({
  rentalId,
  currentHours,
  maxRentalHours,
  hashrate,
  basePricePerUnitPerHour,
  renterFeePct,
}: {
  rentalId: number;
  currentHours: number;
  maxRentalHours: number;
  hashrate: number;
  basePricePerUnitPerHour: number;
  renterFeePct: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const extendRental = useExtendRental();
  const [open, setOpen] = useState(false);
  const remainingCap = Math.max(0, maxRentalHours - currentHours);
  const [extraHours, setExtraHours] = useState<number>(remainingCap > 0 ? 1 : 0);

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setExtraHours(remainingCap > 0 ? Math.min(1, remainingCap) : 0);
    }
  };

  const subtotal = hashrate * basePricePerUnitPerHour * extraHours;
  const fee = subtotal * (renterFeePct / 100);
  const total = subtotal + fee;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (extraHours < 1 || extraHours > remainingCap) {
      toast({
        title: "Invalid duration",
        description: `Add between 1 and ${remainingCap} hour(s).`,
        variant: "destructive",
      });
      return;
    }
    extendRental.mutate(
      { id: rentalId, data: { extraHours } },
      {
        onSuccess: () => {
          toast({ title: "Rental extended", description: `+${extraHours}h added.` });
          queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
          queryClient.invalidateQueries({ queryKey: getGetRentalLiveQueryKey(rentalId) });
          setOpen(false);
        },
        onError: (err) =>
          toast({ title: "Extension failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  if (remainingCap <= 0) {
    return (
      <Button size="sm" variant="outline" className="font-mono text-xs gap-1.5" disabled title={`Already at the rig owner's cap of ${maxRentalHours}h`}>
        <Clock className="w-3 h-3" /> AT_MAX_DURATION
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="font-mono text-xs gap-1.5">
          <Clock className="w-3 h-3" /> EXTEND
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" /> Buy additional hours
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="text-xs text-muted-foreground space-y-1 font-mono">
            <div className="flex justify-between"><span>Current duration</span><span>{currentHours}h</span></div>
            <div className="flex justify-between"><span>Owner's cap</span><span>{maxRentalHours}h</span></div>
            <div className="flex justify-between"><span>Available to add</span><span className="text-primary">{remainingCap}h</span></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="extra-hours">Extra hours</Label>
            <Input
              id="extra-hours"
              type="number"
              min={1}
              max={remainingCap}
              value={extraHours}
              onChange={(e) => setExtraHours(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              className="font-mono"
            />
          </div>
          <div className="rounded-md border border-border/50 bg-muted/20 p-3 space-y-1 text-xs font-mono">
            <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
            <div className="flex justify-between text-muted-foreground"><span>Service fee ({renterFeePct}%)</span><span>${fee.toFixed(2)}</span></div>
            <div className="flex justify-between font-bold pt-1 border-t border-border/40"><span>Total to charge</span><span className="text-primary">${total.toFixed(2)}</span></div>
            <div className="text-[10px] text-muted-foreground pt-1">New end time will be pushed +{extraHours}h. Pricing locked at the rate of your original rental.</div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1 font-mono text-xs" onClick={() => setOpen(false)} disabled={extendRental.isPending}>
              CANCEL
            </Button>
            <Button type="submit" className="flex-1 font-mono text-xs" disabled={extendRental.isPending || extraHours < 1}>
              {extendRental.isPending ? "PROCESSING..." : "PAY_AND_EXTEND"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatusDot({ connected, label, sublabel, error, warn }: { connected: boolean; label: string; sublabel?: string; error?: boolean; warn?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
      error
        ? 'text-red-500 border-red-500/30 bg-red-500/10'
        : warn
          ? 'text-purple-400 border-purple-500/30 bg-purple-500/10'
          : connected
            ? 'text-green-500 border-green-500/30 bg-green-500/10'
            : 'text-muted-foreground border-border/40 bg-muted/20'
    }`}>
      <div className={`w-2 h-2 rounded-full shrink-0 ${error ? 'bg-red-500' : warn ? 'bg-purple-400 animate-pulse' : connected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/50'}`} />
      <div>
        <p className="text-xs font-mono font-semibold">{label}</p>
        {sublabel && <p className="text-[10px] opacity-70">{sublabel}</p>}
      </div>
    </div>
  );
}

export default function RentalCockpit() {
  const { id } = useParams<{ id: string }>();
  const rentalId = parseInt(id || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: me } = useGetMe();
  const { data: rental, isLoading: rentalLoading } = useGetRental(rentalId, {
    query: {
      // Auto-refresh the rental record so status transitions (auto-cancel,
      // settle, complete) propagate without a manual reload — otherwise the
      // page is stuck thinking the rental is still active and the live/stats
      // pollers eventually go stale (matches user-reported "stats stop").
      refetchInterval: 30000,
      refetchIntervalInBackground: true,
      queryKey: getGetRentalQueryKey(rentalId),
    },
  });

  const isRenter = !!me && !!rental && me.id === rental.renterId;

  const { data: live } = useGetRentalLive(rentalId, {
    query: {
      enabled: !!rentalId && rental?.status === 'active',
      refetchInterval: 5000,
      // Keep polling even when the tab is in the background so reopening
      // doesn't show a flat-lined chart.
      refetchIntervalInBackground: true,
      queryKey: getGetRentalLiveQueryKey(rentalId),
    },
  });

  const { data: stats } = useGetRentalStats(rentalId, {
    query: {
      // Fetch stats for active rentals (polling every 30s) AND for finished
      // rentals (one-shot fetch — no polling) so renters can revisit a
      // completed/cancelled rental and see the full historical chart.
      enabled: !!rentalId && !!rental,
      refetchInterval: rental?.status === 'active' ? 30000 : false,
      refetchIntervalInBackground: true,
      queryKey: getGetRentalStatsQueryKey(rentalId),
    },
  });

  // When the /live endpoint reports the rental has ended (status != active),
  // immediately invalidate the rental query so the page switches to the
  // completed view without waiting for the 30-s rental polling interval.
  useEffect(() => {
    if (live?.status && live.status !== 'active') {
      queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
    }
  }, [live?.status, rentalId, queryClient]);

  const cancelRental = useCancelRental();
  const createReview = useCreateRentalReview();

  const [reviewRating, setReviewRating] = useState(5);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rentalRange, setRentalRange] = useState<number | null>(null);

  const handleCancel = () => {
    if (confirm("Are you sure you want to cancel this rental? You will be refunded for the remaining time.")) {
      cancelRental.mutate({ id: rentalId }, {
        onSuccess: () => {
          toast({ title: "Rental Cancelled" });
          queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
        },
        onError: (err) => {
          toast({ title: "Cancellation Failed", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const handleReviewSubmit = () => {
    if (!reviewBody.trim()) {
      toast({ title: "Validation Error", description: "Please enter a review.", variant: "destructive" });
      return;
    }
    createReview.mutate({ id: rentalId, data: { rating: reviewRating, body: reviewBody } }, {
      onSuccess: () => {
        toast({ title: "Review Submitted" });
        setReviewOpen(false);
      },
      onError: (err) => {
        toast({ title: "Submission Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  if (rentalLoading) return <div className="p-8 text-center font-mono text-muted-foreground">INITIALIZING_COCKPIT...</div>;
  if (!rental) return <div className="p-8 text-center font-mono text-destructive">RENTAL_NOT_FOUND</div>;

  const totalSeconds = rental.hours * 3600;
  const elapsedPercent = live ? ((totalSeconds - live.secondsRemaining) / totalSeconds) * 100 : 0;

  const minerConnected = live?.minerConnected ?? false;
  const poolConnected = live?.upstreamConnected ?? false;
  const poolAuthFailed = live?.poolAuthFailed ?? false;

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">Rental #{rental.id}</h1>
            <Badge variant="outline" className={`font-mono text-xs uppercase
              ${rental.status === 'active' ? 'bg-primary/20 text-primary border-primary/30' :
                rental.status === 'completed' ? 'bg-green-500/20 text-green-500 border-green-500/30' :
                rental.status === 'pending' ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30' :
                'bg-destructive/20 text-destructive border-destructive/30'}`}>
              {rental.status}
            </Badge>
          </div>
          <p className="text-muted-foreground flex items-center gap-2">
            <Server className="w-4 h-4" /> {rental.rigName} · {rental.algorithmName}
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          {rental.status === 'active' && isRenter && (
            <ExtendRentalDialog
              rentalId={rental.id}
              currentHours={rental.hours}
              maxRentalHours={rental.maxRentalHours}
              hashrate={rental.hashrate}
              basePricePerUnitPerHour={rental.basePricePerUnitPerHour}
              renterFeePct={rental.renterFeePct}
            />
          )}
          {rental.status === 'active' && (
            <Button variant="destructive" className="font-mono text-xs" onClick={handleCancel} disabled={cancelRental.isPending}>
              TERMINATE_RENTAL
            </Button>
          )}
          {rental.status === 'completed' && (
            <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
              <DialogTrigger asChild>
                <Button className="font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90">
                  LEAVE_REVIEW
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Review your experience</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Rating</Label>
                    <div className="flex gap-2">
                      {[1,2,3,4,5].map(star => (
                        <Star
                          key={star}
                          className={`w-6 h-6 cursor-pointer ${star <= reviewRating ? 'text-yellow-500 fill-current' : 'text-muted-foreground'}`}
                          onClick={() => setReviewRating(star)}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Comments</Label>
                    <Textarea
                      placeholder="How did the rig perform?"
                      value={reviewBody}
                      onChange={(e) => setReviewBody(e.target.value)}
                      className="bg-background"
                    />
                  </div>
                  <Button onClick={handleReviewSubmit} disabled={createReview.isPending} className="w-full">
                    {createReview.isPending ? "SUBMITTING..." : "SUBMIT_REVIEW"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Telemetry */}
        <div className="md:col-span-2 space-y-6">

          {/* Connection status — always visible when rental is active */}
          {rental.status === 'active' && (
            <div className="grid grid-cols-2 gap-3">
              <StatusDot
                connected={minerConnected}
                label="OWNER'S RIG"
                sublabel={minerConnected ? "Connected to proxy" : "Waiting for miner connection"}
              />
              <StatusDot
                connected={poolConnected}
                error={!poolConnected && poolAuthFailed}
                warn={minerConnected && !poolConnected && !poolAuthFailed}
                label="YOUR POOL"
                sublabel={
                  poolConnected ? "Receiving hashrate"
                  : poolAuthFailed ? "Pool rejected credentials"
                  : minerConnected ? "Pool disconnected — reconnecting"
                  : "Waiting for rig first"
                }
              />
            </div>
          )}

          {/* Live Telemetry card */}
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Live Telemetry
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                if (rental.status !== 'active' || !live) return null;
                // Has the rig EVER produced data for this rental? If yes,
                // we always render the stats panel — even when the miner is
                // momentarily offline — using DB-persisted values, so the
                // renter doesn't lose visibility on what's happened so far.
                const hasHistory =
                  (stats && stats.samples.length > 0) ||
                  (live.sharesAccepted ?? 0) > 0 ||
                  rental.deliveredHashrateAvg != null;
                if (!live.minerConnected && !hasHistory) {
                  return (
                    <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10">
                      <WifiOff className="w-8 h-8 text-muted-foreground mb-4" />
                      <p className="font-mono text-sm text-muted-foreground uppercase">AWAITING_MINER — owner's rig is not connected yet.</p>
                      <p className="text-xs text-muted-foreground mt-2">Hashrate will flow to your pool once the rig connects. Polling every 5s.</p>
                    </div>
                  );
                }
                if (live.minerConnected && poolAuthFailed) {
                  return (
                    <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-red-500/20 rounded-lg bg-red-500/5">
                      <ShieldAlert className="w-8 h-8 text-red-500 mb-4" />
                      <p className="font-mono text-sm text-red-500 uppercase">POOL_AUTH_FAILED — credentials rejected</p>
                      <p className="text-xs text-muted-foreground mt-2 max-w-sm">Your pool rejected the worker name or password. Go back and edit the rental pool details, or contact pool support.</p>
                    </div>
                  );
                }
                // Either fully connected, OR temporarily disconnected but
                // has past shares — render the live stats panel either way.
                //
                // Grace-period fix: the backend keeps minerConnected=true for
                // 15 min after the last share so the UI doesn't flap on
                // normal ASIC reconnect cycles. We detect a real disconnect by
                // watching currentHashrateH drop to 0 — that signal is
                // immediate and never smoothed by the grace period.
                const hasDelivered = (live.sharesAccepted ?? 0) > 0;
                const hashrateZeroNow = (live.currentHashrateH ?? 0) === 0;
                // Red banner: confirmed offline (post-grace) OR hashrate dropped
                // with prior delivery history (catches grace-period case).
                const showOffline =
                  !live.minerConnected ||
                  (hasDelivered && hashrateZeroNow && (live.upstreamConnected ?? true));
                // Purple banner: miner socket is up but pool uplink is down.
                const showEstablishing =
                  live.minerConnected && !live.upstreamConnected;
                const avgHashrateDisplay = stats
                  ? formatHashrate(stats.averageHashrate, rental.algorithmUnit)
                  : rental.deliveredHashrateAvg != null
                    ? formatHashrate(rental.deliveredHashrateAvg, rental.algorithmUnit)
                    : '—';
                const deliveryRatioDisplay = stats
                  ? stats.deliveryRatio
                  : live.deliveryRatio;
                return (
                <div className="space-y-6">
                  {showOffline ? (
                    <div className="flex items-center gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3">
                      <WifiOff className="w-5 h-5 text-red-500 shrink-0" />
                      <div className="text-xs">
                        <div className="font-mono font-bold text-red-500 uppercase">Rig offline — reconnecting</div>
                        <div className="text-muted-foreground">Showing the most recent data from this rental. Live values resume the moment the rig sends a share.</div>
                      </div>
                    </div>
                  ) : null}
                  {showEstablishing ? (
                    <div className="flex items-center gap-3 rounded-md border border-purple-500/30 bg-purple-500/10 p-3">
                      <Wifi className="w-5 h-5 text-purple-400 shrink-0 animate-pulse" />
                      <div className="text-xs">
                        <div className="font-mono font-bold text-purple-400 uppercase">Pool disconnected — reconnecting</div>
                        <div className="text-muted-foreground">Rig is connected to proxy but pool link dropped. Will reconnect automatically.</div>
                      </div>
                    </div>
                  ) : null}
                  {/* Workers table — only shown when multiple sessions exist */}
                  {(() => {
                    const ws = (live as any).workers as Array<{
                      sessionId: string; rigName: string; currentDifficulty: number;
                      sharesAccepted: number; sharesRejected: number;
                      upstreamConnected: boolean; connectedAt: string;
                    }> | undefined;
                    if (!ws || ws.length < 1) return null;
                    const fmtDiff = (d: number) =>
                      d >= 1_000_000 ? `${(d/1_000_000).toFixed(2)}M`
                      : d >= 1_000 ? `${(d/1_000).toFixed(1)}K`
                      : d.toLocaleString();
                    return (
                      <div className="rounded-md border border-border/50 overflow-hidden">
                        <div className="px-3 py-2 bg-muted/20 border-b border-border/30 flex items-center gap-2">
                          <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase">Workers ({ws.length} connected)</span>
                        </div>
                        <table className="w-full text-xs font-mono">
                          <thead>
                            <tr className="border-b border-border/20 text-[9px] text-muted-foreground uppercase">
                              <th className="px-3 py-1.5 text-left">Worker</th>
                              <th className="px-3 py-1.5 text-right">Difficulty</th>
                              <th className="px-3 py-1.5 text-right">Shares A/R</th>
                              <th className="px-3 py-1.5 text-right">Pool</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ws.map((w) => (
                              <tr key={w.sessionId} className="border-b border-border/10 last:border-0 hover:bg-muted/10">
                                <td className="px-3 py-1.5 text-foreground truncate max-w-[120px]">{w.rigName}</td>
                                <td className="px-3 py-1.5 text-right text-sky-400">{fmtDiff(w.currentDifficulty)}</td>
                                <td className="px-3 py-1.5 text-right">
                                  <span className="text-green-500">{w.sharesAccepted}</span>
                                  <span className="text-muted-foreground"> / </span>
                                  <span className="text-destructive">{w.sharesRejected}</span>
                                </td>
                                <td className="px-3 py-1.5 text-right">
                                  {w.upstreamConnected
                                    ? <span className="text-green-500">●</span>
                                    : <span className="text-muted-foreground">○</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Current Hashrate</span>
                      <span className={`font-mono text-lg font-bold ${showOffline ? 'text-muted-foreground' : 'text-primary'}`}>{formatHashrate(live.currentHashrate, rental.algorithmUnit)}</span>
                      <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">Σ(diff × 2³²) / time</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Avg Hashrate</span>
                      <span className="font-mono text-lg font-bold">{avgHashrateDisplay}</span>
                      <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">since rental start</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Share Difficulty</span>
                      <span className={`font-mono text-lg font-bold ${showOffline ? 'text-muted-foreground' : 'text-sky-400'}`}>
                        {live.currentDifficulty >= 1_000_000
                          ? `${(live.currentDifficulty / 1_000_000).toFixed(2)}M`
                          : live.currentDifficulty >= 1_000
                          ? `${(live.currentDifficulty / 1_000).toFixed(1)}K`
                          : live.currentDifficulty.toLocaleString()}
                      </span>
                      <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">pool-set per share</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Delivery Ratio</span>
                      <span className={`font-mono text-lg font-bold ${deliveryRatioDisplay >= 0.95 ? 'text-green-500' : deliveryRatioDisplay >= 0.8 ? 'text-yellow-500' : 'text-destructive'}`}>
                        {(deliveryRatioDisplay * 100).toFixed(1)}%
                      </span>
                      <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">actual / advertised</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Accept Rate</span>
                      {(() => {
                        const total = (live.sharesAccepted ?? 0) + (live.sharesRejected ?? 0);
                        const rate = total > 0 ? (live.sharesAccepted ?? 0) / total : 1;
                        return (
                          <span className={`font-mono text-lg font-bold ${rate >= 0.99 ? 'text-green-500' : rate >= 0.95 ? 'text-yellow-500' : 'text-destructive'}`}>
                            {(rate * 100).toFixed(1)}%
                          </span>
                        );
                      })()}
                      <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">{live.sharesAccepted ?? 0}A / {live.sharesRejected ?? 0}R</span>
                    </div>
                  </div>

                  {stats && stats.samples.length > 1 ? (() => {
                    const rentalRangeOptions = [
                      { label: '1H',  ms: 3_600_000 },
                      { label: '6H',  ms: 6 * 3_600_000 },
                      { label: '12H', ms: 12 * 3_600_000 },
                      { label: '1D',  ms: 86_400_000 },
                      { label: '1W',  ms: 7 * 86_400_000 },
                      { label: 'MAX', ms: null },
                    ] as const;
                    const now = Date.now();
                    const nowMs = now;
                    // Use numeric ms timestamps throughout — categorical string XAxis
                    // requires exact data-point matches for ReferenceArea positioning.
                    const filteredRaw = rentalRange !== null
                      ? stats.samples.filter(s => new Date(s.timestamp).getTime() > now - rentalRange)
                      : stats.samples;
                    const filtered = filteredRaw.map(s => ({ ...s, ts: new Date(s.timestamp).getTime() }));
                    const lastFilteredSample = filtered.length > 0 ? filtered[filtered.length - 1] : null;

                    // Current-state live areas (from last sample → now).
                    const showMinerOfflineArea =
                      (!live?.minerConnected || (hasDelivered && hashrateZeroNow && (live?.upstreamConnected ?? true))) &&
                      !!lastFilteredSample;

                    // Historical offline periods — numeric ms, clamped to window.
                    const windowStart = rentalRange ? now - rentalRange : 0;
                    const offlineRanges = (stats.offlinePeriods ?? [])
                      .filter(p => {
                        const endMs = p.end ? new Date(p.end).getTime() : Infinity;
                        return endMs > windowStart;
                      })
                      .map(p => ({
                        start: Math.max(new Date(p.start).getTime(), windowStart),
                        end: p.end ? new Date(p.end).getTime() : nowMs,
                      }));
                    const showPoolOfflineArea =
                      !!(live?.minerConnected && !live?.upstreamConnected && lastFilteredSample);

                    const isCurrentlyZero = hasDelivered && hashrateZeroNow;
                    const rentalChartData = isCurrentlyZero && filtered.length > 0
                      ? [...filtered, { ts: nowMs, hashrate: 0, timestamp: new Date(nowMs).toISOString() }]
                      : filtered;
                    return (
                    <div className="space-y-1">
                    <div className="flex justify-end gap-1">
                      {rentalRangeOptions.map(opt => (
                        <button
                          key={opt.label}
                          onClick={() => setRentalRange(opt.ms ?? null)}
                          className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                            rentalRange === (opt.ms ?? null)
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="h-32 bg-background/30 rounded-md border border-border/30 px-2 py-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={rentalChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id="hashrateFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#f0b90b" stopOpacity={0.45} />
                              <stop offset="100%" stopColor="#f0b90b" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
                          <YAxis hide domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, toNum(rental.hashrate) * 1.05)]} />
                          {/* Historical rig-offline periods — red */}
                          {offlineRanges.map((r, i) => (
                            <ReferenceArea
                              key={`off-${i}`}
                              x1={r.start}
                              x2={r.end}
                              fill="#ef4444"
                              fillOpacity={0.14}
                              stroke="none"
                              ifOverflow="extendDomain"
                            />
                          ))}
                          {/* Current live state: extends from last sample → now */}
                          {showMinerOfflineArea && lastFilteredSample && (
                            <ReferenceArea
                              x1={lastFilteredSample.ts}
                              x2={nowMs}
                              fill="#ef4444"
                              fillOpacity={0.18}
                              stroke="none"
                              ifOverflow="extendDomain"
                            />
                          )}
                          {showPoolOfflineArea && lastFilteredSample && (
                            <ReferenceArea
                              x1={lastFilteredSample.ts}
                              x2={nowMs}
                              fill="#a855f7"
                              fillOpacity={0.18}
                              stroke="none"
                              ifOverflow="extendDomain"
                            />
                          )}
                          <Tooltip
                            cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
                            contentStyle={{
                              background: 'hsl(var(--background))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: 6,
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              padding: '4px 8px',
                            }}
                            labelStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                            formatter={(v: number) => [formatHashrate(v, rental.algorithmUnit), 'Hashrate']}
                            labelFormatter={(t: number) => new Date(t).toLocaleTimeString()}
                          />
                          <ReferenceLine
                            y={toNum(rental.hashrate)}
                            stroke="#ef4444"
                            strokeDasharray="5 4"
                            strokeWidth={1.5}
                            label={{ value: formatHashrate(toNum(rental.hashrate), rental.algorithmUnit), position: 'insideTopRight', fontSize: 9, fill: '#ef4444', fontFamily: 'var(--font-mono)' }}
                            ifOverflow="extendDomain"
                          />
                          <Area
                            type="monotone"
                            dataKey="hashrate"
                            stroke="#f0b90b"
                            strokeWidth={1.6}
                            fill="url(#hashrateFill)"
                            isAnimationActive={false}
                            dot={false}
                            activeDot={{ r: 3, fill: '#f0b90b', stroke: 'hsl(var(--background))', strokeWidth: 1.5 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                    </div>
                    );
                  })() : (
                    <div className="flex items-center justify-center gap-2 h-16 bg-background/30 rounded-md border border-dashed border-border/30 text-muted-foreground">
                      <BarChart2 className="w-4 h-4" />
                      <span className="text-xs font-mono">Hashrate chart will appear once mining begins</span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-mono text-muted-foreground">
                      <span>TIME_ELAPSED</span>
                      <span>REMAINING: {formatSeconds(live?.secondsRemaining ?? 0)}</span>
                    </div>
                    <Progress value={Math.min(100, Math.max(0, elapsedPercent))} className="h-2" />
                  </div>
                </div>
                );
              })()}
              {rental.status === 'disputed' ? (
                <div className="space-y-4">
                  <div className="text-center pb-2">
                    <ShieldAlert className="w-10 h-10 text-yellow-500 mx-auto mb-3" />
                    <h3 className="font-medium text-lg">Cancellation Under Review</h3>
                  </div>
                  <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm space-y-2">
                    <p>
                      The rig delivered <span className="font-mono font-bold">{stats ? `${(stats.deliveryRatio * 100).toFixed(1)}%` : '—'}</span> of the advertised hashrate (below the 95% threshold).
                    </p>
                    <p>
                      The unused-time portion of your payment was refunded immediately. The remaining used-time portion is <span className="font-bold">frozen</span> while an admin reviews this rental.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      • If the issue was on your mining pool, the frozen amount may be released to the rig owner.<br />
                      • If the rig itself underperformed, the frozen amount will be refunded to you.<br />
                      • If no admin acts within 24 hours of cancellation, the frozen amount is automatically refunded to you.
                    </p>
                    {rental.cancelledAt ? (
                      <p className="text-xs font-mono text-muted-foreground pt-1">
                        Auto-resolves at: {new Date(new Date(rental.cancelledAt).getTime() + 24 * 60 * 60 * 1000).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {rental.status === 'completed' || rental.status === 'cancelled' ? (
                <div className="space-y-6">
                  <div className="text-center pb-2">
                    {rental.status === 'completed' ? <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" /> : <ShieldAlert className="w-10 h-10 text-muted-foreground mx-auto mb-3" />}
                    <h3 className="font-medium text-lg">Workload {rental.status === 'completed' ? 'Completed' : 'Terminated'}</h3>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Avg Hashrate</span>
                      <span className="font-mono text-lg font-bold">{rental.deliveredHashrateAvg != null ? formatHashrate(rental.deliveredHashrateAvg, rental.algorithmUnit) : (stats ? formatHashrate(stats.averageHashrate, rental.algorithmUnit) : '—')}</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Delivery Ratio</span>
                      <span className={`font-mono text-lg font-bold ${stats && stats.deliveryRatio >= 0.95 ? 'text-green-500' : stats && stats.deliveryRatio >= 0.8 ? 'text-yellow-500' : 'text-destructive'}`}>
                        {stats ? `${(stats.deliveryRatio * 100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Shares (A/R)</span>
                      <span className="font-mono text-lg font-bold">
                        <span className="text-green-500">{stats?.sharesAccepted ?? 0}</span> / <span className="text-destructive">{stats?.sharesRejected ?? 0}</span>
                      </span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Status</span>
                      <span className={`font-mono text-lg font-bold ${rental.status === 'completed' ? 'text-green-500' : 'text-muted-foreground'}`}>{rental.status === 'completed' ? 'COMPLETED' : 'TERMINATED'}</span>
                    </div>
                  </div>

                  {stats && stats.samples.length > 1 ? (() => {
                    const nowMs2 = Date.now();
                    const histSamples = stats.samples.map(s => ({ ...s, ts: new Date(s.timestamp).getTime() }));
                    const histOfflineRanges = (stats.offlinePeriods ?? []).map(p => ({
                      start: new Date(p.start).getTime(),
                      end: p.end ? new Date(p.end).getTime() : nowMs2,
                    }));
                    return (
                    <div className="h-32 bg-background/30 rounded-md border border-border/30 px-2 py-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={histSamples} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id="hashrateFillHistory" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#f0b90b" stopOpacity={0.4} />
                              <stop offset="100%" stopColor="#f0b90b" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
                          <YAxis hide domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, toNum(rental.hashrate) * 1.05)]} />
                          {/* Historical offline periods (red) — exact from DB */}
                          {histOfflineRanges.map((r, i) => (
                            <ReferenceArea
                              key={`hist-off-${i}`}
                              x1={r.start}
                              x2={r.end}
                              fill="#ef4444"
                              fillOpacity={0.14}
                              stroke="none"
                              ifOverflow="extendDomain"
                            />
                          ))}
                          <Tooltip
                            cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
                            contentStyle={{
                              background: 'hsl(var(--background))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: 6,
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              padding: '4px 8px',
                            }}
                            labelStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                            formatter={(v: number) => [formatHashrate(v, rental.algorithmUnit), 'Hashrate']}
                            labelFormatter={(t: number) => new Date(t).toLocaleString()}
                          />
                          <ReferenceLine
                            y={toNum(rental.hashrate)}
                            stroke="#ef4444"
                            strokeDasharray="5 4"
                            strokeWidth={1.5}
                            label={{ value: formatHashrate(toNum(rental.hashrate), rental.algorithmUnit), position: 'insideTopRight', fontSize: 9, fill: '#ef4444', fontFamily: 'var(--font-mono)' }}
                            ifOverflow="extendDomain"
                          />
                          <Area
                            type="monotone"
                            dataKey="hashrate"
                            stroke="#f0b90b"
                            strokeWidth={1.4}
                            fill="url(#hashrateFillHistory)"
                            isAnimationActive={false}
                            dot={false}
                            activeDot={{ r: 3, fill: '#f0b90b', stroke: 'hsl(var(--background))', strokeWidth: 1.5 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                    );
                  })() : (
                    <div className="flex items-center justify-center gap-2 h-16 bg-background/30 rounded-md border border-dashed border-border/30 text-muted-foreground">
                      <BarChart2 className="w-4 h-4" />
                      <span className="text-xs font-mono">No hashrate data recorded</span>
                    </div>
                  )}
                </div>
              ) : null}
              {rental.status === 'active' && !live ? (
                <div className="text-center py-10 text-muted-foreground font-mono text-sm">
                  INITIALIZING_PROXY_CONNECTION...
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* Right: Pool config + Rental summary */}
        <div className="space-y-6">

          {/* Renter's destination pool — RENTER-ONLY card. The rig owner sees
              all stats but never the renter's pool credentials (privacy). */}
          {isRenter && (
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-3 flex-row items-center justify-between">
                <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Destination Pool</CardTitle>
                {rental.status === 'active' && (
                  <SwitchPoolDialog
                    rentalId={rental.id}
                    currentUrl={rental.poolUrl}
                    currentWorker={rental.poolWorker}
                    currentPassword={rental.poolPassword}
                  />
                )}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">URL</span>
                  <span className="font-mono text-xs break-all bg-muted/30 px-2 py-1.5 rounded">{rental.poolUrl}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Worker</span>
                  <span className="font-mono text-xs bg-muted/30 px-2 py-1.5 rounded">{rental.poolWorker}</span>
                </div>
                {rental.status === 'active' && (
                  <div className={`flex items-center gap-2 mt-1 text-xs px-2 py-1.5 rounded-md border ${
                    poolConnected
                      ? 'text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30'
                      : 'text-muted-foreground bg-muted/20 border-border/40'
                  }`}>
                    {poolConnected
                      ? <><Wifi className="w-3 h-3" /> Pool is receiving hashrate</>
                      : <><WifiOff className="w-3 h-3" /> Waiting for connection</>
                    }
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Rental summary */}
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Rental Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rig</span>
                <span className="font-medium">{rental.rigName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Duration</span>
                <span className="font-mono">{rental.hours}h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Algorithm</span>
                <span>{rental.algorithmName}</span>
              </div>
              {(() => {
                const refunded = Math.max(0, rental.renterTotalUsd - rental.netPaidUsd);
                const showNet = refunded > 0.0001;
                return (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {showNet ? "Amount Paid" : "Total Cost"}
                      </span>
                      <span className="font-mono font-semibold text-primary">
                        ${rental.netPaidUsd.toFixed(2)}
                      </span>
                    </div>
                    {showNet ? (
                      <>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Original Cost</span>
                          <span className="font-mono text-muted-foreground line-through">
                            ${rental.renterTotalUsd.toFixed(2)}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Refunded</span>
                          <span className="font-mono text-green-500">
                            +${refunded.toFixed(2)}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
