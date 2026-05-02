import { useParams } from "wouter";
import { useGetRental, useGetRentalStats, useGetRentalLive, getGetRentalLiveQueryKey, getGetRentalStatsQueryKey, useCancelRental, useCreateRentalReview, getGetRentalQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatSeconds } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, CheckCircle2, Wifi, WifiOff, ShieldAlert, Star as StarIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

function StatusDot({ connected, label, sublabel, error }: { connected: boolean; label: string; sublabel?: string; error?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
      error
        ? "text-red-500 border-red-500/30 bg-red-500/10"
        : connected
          ? "text-green-500 border-green-500/30 bg-green-500/10"
          : "text-muted-foreground border-border/40 bg-muted/20"
    }`}>
      <div className={`w-2 h-2 rounded-full shrink-0 ${error ? "bg-red-500" : connected ? "bg-green-500 animate-pulse" : "bg-muted-foreground/50"}`} />
      <div>
        <p className="text-xs font-mono font-semibold">{label}</p>
        {sublabel && <p className="text-[10px] opacity-70">{sublabel}</p>}
      </div>
    </div>
  );
}

function HashrateWindow({ label, value, unit, highlight }: { label: string; value: number | undefined; unit: string; highlight?: boolean }) {
  const formatted = value != null && value > 0 ? formatHashrate(value, unit) : "—";
  return (
    <div className={`flex-1 px-5 py-4 rounded-xl border flex flex-col gap-1 ${highlight ? "bg-primary/10 border-primary/40" : "bg-card/40 border-border/40"}`}>
      <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold font-mono tabular-nums ${highlight ? "text-primary" : ""}`}>{formatted}</span>
    </div>
  );
}

function HashrateChart({ samples, unit }: { samples: { timestamp: string | Date; hashrate: number }[]; unit: string }) {
  if (samples.length < 2) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-xs font-mono border border-dashed border-border/30 rounded-lg">
        Chart appears after first samples are recorded (every 60 s)
      </div>
    );
  }

  const data = samples.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    hashrate: parseFloat(s.hashrate.toFixed(3)),
  }));

  const max = Math.max(...data.map((d) => d.hashrate), 1);
  const yMax = Math.ceil(max * 1.15);

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.3)" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, yMax]}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v}`}
          width={36}
        />
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
          formatter={(v: number) => [`${v} ${unit}`, "Hashrate"]}
        />
        <Area
          type="monotone"
          dataKey="hashrate"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#hrGrad)"
          dot={false}
          activeDot={{ r: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function RentalCockpit() {
  const { id } = useParams<{ id: string }>();
  const rentalId = parseInt(id || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rental, isLoading: rentalLoading } = useGetRental(rentalId);

  const { data: live } = useGetRentalLive(rentalId, {
    query: {
      enabled: !!rentalId && rental?.status === "active",
      refetchInterval: 5000,
      queryKey: getGetRentalLiveQueryKey(rentalId),
    },
  });

  const { data: stats } = useGetRentalStats(rentalId, {
    query: {
      enabled: !!rentalId,
      refetchInterval: rental?.status === "active" ? 30000 : false,
      queryKey: getGetRentalStatsQueryKey(rentalId),
    },
  });

  const cancelRental = useCancelRental();
  const createReview = useCreateRentalReview();

  const [reviewRating, setReviewRating] = useState(5);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);

  const handleCancel = () => {
    if (confirm("Are you sure you want to cancel this rental? You will be refunded for the remaining time.")) {
      cancelRental.mutate({ id: rentalId }, {
        onSuccess: () => {
          toast({ title: "Rental Cancelled" });
          queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
        },
        onError: (err) => {
          toast({ title: "Cancellation Failed", description: err.message, variant: "destructive" });
        },
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
      },
    });
  };

  if (rentalLoading) return <div className="p-8 text-center font-mono text-muted-foreground">INITIALIZING...</div>;
  if (!rental) return <div className="p-8 text-center font-mono text-destructive">RENTAL_NOT_FOUND</div>;

  const totalSeconds = rental.hours * 3600;
  const secondsRemaining = live?.secondsRemaining ?? stats?.secondsRemaining ?? 0;
  const elapsedPercent = ((totalSeconds - secondsRemaining) / totalSeconds) * 100;

  const minerConnected = live?.minerConnected ?? stats?.minerConnected ?? false;
  const poolConnected = live?.upstreamConnected ?? stats?.upstreamConnected ?? false;
  const poolAuthFailed = live?.poolAuthFailed ?? stats?.poolAuthFailed ?? false;
  const unit = rental.algorithmUnit;

  const currentHashrate = live?.currentHashrate ?? 0;
  const hashrate10m = stats?.hashrate10m ?? 0;
  const hashrate1h = stats?.hashrate1h ?? 0;
  const deliveryRatio = live?.deliveryRatio ?? stats?.deliveryRatio ?? 0;
  const sharesAccepted = live?.sharesAccepted ?? stats?.sharesAccepted ?? 0;
  const sharesRejected = live?.sharesRejected ?? stats?.sharesRejected ?? 0;
  const rejectRate = sharesAccepted + sharesRejected > 0
    ? ((sharesRejected / (sharesAccepted + sharesRejected)) * 100).toFixed(2)
    : "0.00";

  const isActive = rental.status === "active";

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">Rental #{rental.id}</h1>
            <Badge variant="outline" className={`font-mono text-xs uppercase
              ${rental.status === "active" ? "bg-primary/20 text-primary border-primary/30" :
                rental.status === "completed" ? "bg-green-500/20 text-green-500 border-green-500/30" :
                rental.status === "pending" ? "bg-yellow-500/20 text-yellow-500 border-yellow-500/30" :
                "bg-destructive/20 text-destructive border-destructive/30"}`}>
              {rental.status}
            </Badge>
          </div>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Server className="w-4 h-4" /> {rental.rigName} · {rental.algorithmName}
          </p>
        </div>

        <div className="flex gap-2">
          {isActive && (
            <Button variant="destructive" size="sm" className="font-mono text-xs" onClick={handleCancel} disabled={cancelRental.isPending}>
              TERMINATE
            </Button>
          )}
          {rental.status === "completed" && (
            <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="font-mono text-xs">LEAVE_REVIEW</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Review your experience</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Rating</Label>
                    <div className="flex gap-2">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <StarIcon
                          key={star}
                          className={`w-6 h-6 cursor-pointer ${star <= reviewRating ? "text-yellow-500 fill-current" : "text-muted-foreground"}`}
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

      {/* Connection status */}
      {isActive && (
        <div className="grid grid-cols-2 gap-3">
          <StatusDot
            connected={minerConnected}
            label="OWNER'S RIG"
            sublabel={minerConnected ? "Connected to proxy" : "Waiting for miner"}
          />
          <StatusDot
            connected={poolConnected}
            error={!poolConnected && poolAuthFailed}
            label="YOUR POOL"
            sublabel={
              poolConnected ? "Receiving hashrate"
              : poolAuthFailed ? "Credentials rejected"
              : minerConnected ? "Connecting..."
              : "Waiting for rig"
            }
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Hashrate + Chart */}
        <div className="md:col-span-2 space-y-4">

          {/* Hashrate windows — always show when active OR completed with data */}
          {(isActive || (stats && (hashrate10m > 0 || hashrate1h > 0))) && (
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" /> Hashrate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 3-window display like ViaBTC */}
                <div className="flex gap-3">
                  <HashrateWindow label="10-Min" value={hashrate10m > 0 ? hashrate10m : undefined} unit={unit} highlight />
                  <HashrateWindow label="1-Hour" value={hashrate1h > 0 ? hashrate1h : undefined} unit={unit} />
                  <HashrateWindow label="Current" value={currentHashrate > 0 ? currentHashrate : undefined} unit={unit} />
                </div>

                {/* Chart */}
                {stats?.samples && (
                  <HashrateChart samples={stats.samples} unit={unit} />
                )}

                {/* Shares + reject rate */}
                <div className="flex flex-wrap gap-4 text-sm pt-1 border-t border-border/30">
                  <div className="flex gap-1.5 items-center">
                    <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                    <span className="text-muted-foreground text-xs">Accepted</span>
                    <span className="font-mono font-semibold text-green-500 text-xs">{sharesAccepted.toLocaleString()}</span>
                  </div>
                  <div className="flex gap-1.5 items-center">
                    <span className="w-2 h-2 rounded-full bg-destructive shrink-0" />
                    <span className="text-muted-foreground text-xs">Rejected</span>
                    <span className="font-mono font-semibold text-destructive text-xs">{sharesRejected.toLocaleString()}</span>
                  </div>
                  <div className="flex gap-1.5 items-center">
                    <span className="text-muted-foreground text-xs">Reject Rate</span>
                    <span className="font-mono font-semibold text-xs">{rejectRate}%</span>
                  </div>
                  {isActive && hashrate1h > 0 && (
                    <div className="flex gap-1.5 items-center ml-auto">
                      <span className="text-muted-foreground text-xs">Delivery</span>
                      <span className={`font-mono font-semibold text-xs ${
                        deliveryRatio >= 0.95 ? "text-green-500" :
                        deliveryRatio >= 0.8 ? "text-yellow-500" :
                        "text-destructive"
                      }`}>{(deliveryRatio * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Status message when not yet mining */}
          {isActive && !minerConnected && (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-10 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10 m-2">
                <WifiOff className="w-8 h-8 text-muted-foreground mb-3" />
                <p className="font-mono text-sm text-muted-foreground uppercase">AWAITING_MINER</p>
                <p className="text-xs text-muted-foreground mt-2">Owner's rig is not connected yet. Polling every 5 s.</p>
              </CardContent>
            </Card>
          )}

          {isActive && minerConnected && poolAuthFailed && (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-10 flex flex-col items-center justify-center border border-dashed border-red-500/20 rounded-lg bg-red-500/5 m-2">
                <ShieldAlert className="w-8 h-8 text-red-500 mb-3" />
                <p className="font-mono text-sm text-red-500 uppercase">POOL_AUTH_FAILED</p>
                <p className="text-xs text-muted-foreground mt-2 max-w-sm text-center">Your pool rejected worker credentials. Check the worker name and password.</p>
              </CardContent>
            </Card>
          )}

          {isActive && minerConnected && !poolConnected && !poolAuthFailed && hashrate10m === 0 && (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-8 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10 m-2">
                <Wifi className="w-7 h-7 text-yellow-500 animate-pulse mb-3" />
                <p className="font-mono text-sm text-yellow-500 uppercase">ESTABLISHING_POOL_LINK</p>
                <p className="text-xs text-muted-foreground mt-2">Hash will appear once the first share is submitted.</p>
              </CardContent>
            </Card>
          )}

          {/* Completed / Cancelled summary */}
          {!isActive && (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-10 text-center">
                {rental.status === "completed"
                  ? <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
                  : <ShieldAlert className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                }
                <h3 className="font-medium text-lg">Workload {rental.status === "completed" ? "Completed" : "Terminated"}</h3>
                {rental.deliveredHashrateAvg != null && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Final average delivered: <span className="font-mono text-foreground">{formatHashrate(rental.deliveredHashrateAvg, unit)}</span>
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Time progress */}
          {isActive && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-mono text-muted-foreground">
                <span>TIME_ELAPSED</span>
                <span>REMAINING: {formatSeconds(secondsRemaining)}</span>
              </div>
              <Progress value={Math.min(100, Math.max(0, elapsedPercent))} className="h-1.5" />
            </div>
          )}
        </div>

        {/* Right: Pool config + Summary */}
        <div className="space-y-4">
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Destination Pool</CardTitle>
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
              {isActive && (
                <div className={`flex items-center gap-2 mt-1 text-xs px-2 py-1.5 rounded-md border ${
                  poolConnected
                    ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30"
                    : "text-muted-foreground bg-muted/20 border-border/40"
                }`}>
                  {poolConnected
                    ? <><Wifi className="w-3 h-3" /> Receiving hashrate</>
                    : <><WifiOff className="w-3 h-3" /> Not connected</>
                  }
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Rental Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rig</span>
                <span className="font-medium truncate ml-2 max-w-[140px]">{rental.rigName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Duration</span>
                <span className="font-mono">{rental.hours}h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Algorithm</span>
                <span>{rental.algorithmName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Advertised</span>
                <span className="font-mono">{formatHashrate(rental.hashrate, unit)}</span>
              </div>
              <div className="flex justify-between border-t border-border/30 pt-2">
                <span className="text-muted-foreground">Total Cost</span>
                <span className="font-mono font-semibold text-primary">${rental.renterTotalUsd.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
