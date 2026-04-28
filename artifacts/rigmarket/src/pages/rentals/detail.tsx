import { useEffect } from "react";
import { useParams } from "wouter";
import { useGetRental, useGetRentalStats, useGetRentalLive, getGetRentalLiveQueryKey, getGetRentalStatsQueryKey, useCancelRental, useCreateRentalReview, getGetRentalQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatSeconds } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, Copy, ShieldAlert, CheckCircle2, Wifi, WifiOff, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { Star } from "lucide-react";

function ConnectionBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded-full border ${
      connected 
        ? 'text-green-500 border-green-500/40 bg-green-500/10' 
        : 'text-muted-foreground border-border/50 bg-muted/20'
    }`}>
      {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {label}
    </div>
  );
}

export default function RentalCockpit() {
  const { id } = useParams<{ id: string }>();
  const rentalId = parseInt(id || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // orval defaults `enabled: !!id`, so we can omit the query option for the rental fetch.
  const { data: rental, isLoading: rentalLoading } = useGetRental(rentalId);

  // Real-time proxy snapshot — polled every 5s while the rental is active.
  const { data: live } = useGetRentalLive(rentalId, {
    query: {
      enabled: !!rentalId && rental?.status === 'active',
      refetchInterval: 5000,
      queryKey: getGetRentalLiveQueryKey(rentalId),
    },
  });

  // Historical stats (sparkline + averageHashrate) — still polled for the chart.
  const { data: stats } = useGetRentalStats(rentalId, {
    query: {
      enabled: !!rentalId && rental?.status === 'active',
      refetchInterval: 30000,
      queryKey: getGetRentalStatsQueryKey(rentalId),
    },
  });

  const cancelRental = useCancelRental();
  const createReview = useCreateRentalReview();

  const [reviewRating, setReviewRating] = useState(5);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard", description: `${label} copied.` });
  };

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

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
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
            <Server className="w-4 h-4" /> {rental.rigName} • {rental.algorithmName}
          </p>
        </div>

        <div className="flex gap-2">
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
        <div className="md:col-span-2 space-y-6">
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Live Telemetry
                {rental.status === 'active' && live && (
                  <div className="flex items-center gap-2 ml-auto">
                    <ConnectionBadge connected={live.minerConnected} label="MINER" />
                    <ArrowRight className="w-3 h-3 text-muted-foreground" />
                    <ConnectionBadge connected={live.upstreamConnected} label="POOL" />
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {rental.status === 'active' && live && !live.minerConnected ? (
                 <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10">
                    <Activity className="w-8 h-8 text-primary animate-pulse mb-4" />
                    <p className="font-mono text-sm text-primary uppercase">AWAITING_MINER — point your rig at the proxy URL shown on the right.</p>
                    <p className="text-xs text-muted-foreground mt-2">Polling every 5s.</p>
                 </div>
              ) : rental.status === 'active' && live && live.minerConnected && !live.upstreamConnected ? (
                <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10">
                  <Wifi className="w-8 h-8 text-yellow-500 animate-pulse mb-4" />
                  <p className="font-mono text-sm text-yellow-500 uppercase">MINER_CONNECTED — ESTABLISHING POOL LINK</p>
                  <p className="text-xs text-muted-foreground mt-2">Proxy is connecting to your destination pool. Hash will start flowing shortly.</p>
                </div>
              ) : rental.status === 'active' && live ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Current Hashrate</span>
                      <span className="font-mono text-lg font-bold text-primary">{formatHashrate(live.currentHashrate, rental.algorithmUnit)}</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Avg Hashrate</span>
                      <span className="font-mono text-lg font-bold">{stats ? formatHashrate(stats.averageHashrate, rental.algorithmUnit) : '—'}</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Delivery Ratio</span>
                      <span className={`font-mono text-lg font-bold ${live.deliveryRatio >= 0.95 ? 'text-green-500' : live.deliveryRatio >= 0.8 ? 'text-yellow-500' : 'text-destructive'}`}>
                        {(live.deliveryRatio * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Shares (A/R)</span>
                      <span className="font-mono text-lg font-bold"><span className="text-green-500">{live.sharesAccepted}</span> / <span className="text-destructive">{live.sharesRejected}</span></span>
                    </div>
                  </div>

                  {stats && stats.samples.length > 1 && (
                    <div className="flex items-end gap-0.5 h-16 bg-background/30 rounded-md border border-border/30 px-3 py-2">
                      {stats.samples.map((s, i) => {
                        const max = Math.max(...stats.samples.map((x) => x.hashrate), 1);
                        const h = Math.max(4, (s.hashrate / max) * 100);
                        return (
                          <div
                            key={i}
                            title={`${formatHashrate(s.hashrate, rental.algorithmUnit)}`}
                            style={{ height: `${h}%` }}
                            className="flex-1 rounded-sm bg-primary/60 min-w-[2px]"
                          />
                        );
                      })}
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
              ) : rental.status === 'completed' || rental.status === 'cancelled' ? (
                <div className="text-center py-10">
                  {rental.status === 'completed' ? <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" /> : <ShieldAlert className="w-10 h-10 text-muted-foreground mx-auto mb-3" />}
                  <h3 className="font-medium text-lg">Workload {rental.status === 'completed' ? 'Completed' : 'Terminated'}</h3>
                  {rental.deliveredHashrateAvg !== null && (
                    <p className="text-sm text-muted-foreground mt-2">
                      Final average delivered hashrate: <span className="font-mono text-foreground">{formatHashrate(rental.deliveredHashrateAvg, rental.algorithmUnit)}</span>
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-center py-10 text-muted-foreground font-mono text-sm">
                  INITIALIZING_PROXY_CONNECTION...
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Rig Connection Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Stratum Proxy URL</Label>
                <div className="flex">
                  <Input readOnly value={rental.stratumProxyUrl} className="font-mono text-xs bg-muted/30 rounded-r-none focus-visible:ring-0" />
                  <Button variant="outline" className="rounded-l-none px-3" onClick={() => copyToClipboard(rental.stratumProxyUrl, 'Proxy URL')}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Proxy Worker</Label>
                <div className="flex">
                  <Input readOnly value={rental.proxyWorker} className="font-mono text-xs bg-muted/30 rounded-r-none focus-visible:ring-0" />
                  <Button variant="outline" className="rounded-l-none px-3" onClick={() => copyToClipboard(rental.proxyWorker, 'Worker')}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Proxy Password</Label>
                <div className="flex">
                  <Input readOnly value={rental.proxyPassword} className="font-mono text-xs bg-muted/30 rounded-r-none focus-visible:ring-0" />
                  <Button variant="outline" className="rounded-l-none px-3" onClick={() => copyToClipboard(rental.proxyPassword, 'Password')}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
             <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">Destination Pool</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">URL</span>
                <span className="font-mono break-all">{rental.poolUrl}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Worker</span>
                <span className="font-mono">{rental.poolWorker}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
