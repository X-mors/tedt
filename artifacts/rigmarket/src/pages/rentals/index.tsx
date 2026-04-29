import { useState, useEffect } from "react";
import { useListMyRentals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format, formatDistanceToNow, isPast } from "date-fns";
import { Link } from "wouter";
import {
  Activity, Server, Clock, TrendingUp, Zap, History,
  ArrowRight, Wifi, WifiOff,
} from "lucide-react";

function LiveCountdown({ endsAt }: { endsAt: string }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const tick = () => {
      const end = new Date(endsAt);
      if (isPast(end)) { setRemaining("Ending..."); return; }
      const diff = end.getTime() - Date.now();
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRemaining(h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  return <span className="font-mono text-primary">{remaining}</span>;
}

function DeliveryBar({ ratio }: { ratio: number }) {
  const pct = Math.min(100, Math.round(ratio * 100));
  const color = pct >= 95 ? "bg-green-500" : pct >= 80 ? "bg-yellow-500" : "bg-destructive";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono ${pct >= 95 ? "text-green-500" : pct >= 80 ? "text-yellow-500" : "text-destructive"}`}>
        {pct}%
      </span>
    </div>
  );
}

export default function MyRentals() {
  const { data: rentals, isLoading } = useListMyRentals();

  const active = rentals?.filter(r => r.status === "active") ?? [];
  const history = rentals?.filter(r => r.status !== "active") ?? [];
  const totalSpent = rentals?.reduce((s, r) => s + r.renterTotalUsd, 0) ?? 0;

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Rentals</h1>
        <p className="text-muted-foreground">Active and historical workloads</p>
      </div>

      {/* Summary strip */}
      {!isLoading && rentals && rentals.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <Zap className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold text-primary">{active.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Active</div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <History className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold">{rentals.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Total Rentals</div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <TrendingUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold">{formatMoney(totalSpent)}</div>
              <div className="text-xs text-muted-foreground uppercase">Total Spent</div>
            </div>
          </div>
        </div>
      )}

      {/* Active rentals */}
      {(isLoading || active.length > 0) && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Live Workloads</h2>
          </div>

          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground font-mono text-sm">LOADING...</div>
          ) : active.map(rental => (
            <Card key={rental.id} className="bg-card/50 border-primary/20 hover:border-primary/40 transition-colors">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="font-mono text-[10px] uppercase bg-primary/20 text-primary border-primary/30">
                        ACTIVE
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">#{rental.id}</span>
                    </div>
                    <div className="font-semibold flex items-center gap-2">
                      <Server className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      {rental.rigName}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{rental.algorithmName}</div>
                  </div>

                  <div className="grid grid-cols-3 gap-4 text-center sm:text-right flex-shrink-0">
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Hashrate</div>
                      <div className="font-mono text-sm font-bold text-primary">
                        {formatHashrate(rental.hashrate, rental.algorithmUnit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Time Left</div>
                      <div className="flex items-center justify-center sm:justify-end gap-1 text-sm">
                        <Clock className="w-3 h-3 text-primary" />
                        <LiveCountdown endsAt={rental.endsAt} />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Cost</div>
                      <div className="font-mono text-sm">{formatMoney(rental.renterTotalUsd)}</div>
                    </div>
                  </div>

                  <Link href={`/rentals/${rental.id}`}>
                    <Button size="sm" className="font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 w-full sm:w-auto">
                      <Activity className="w-3 h-3" />
                      MONITOR
                      <ArrowRight className="w-3 h-3" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* History */}
      {!isLoading && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">History</h2>
          </div>

          {history.length === 0 && active.length === 0 ? (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="py-16 text-center">
                <Zap className="w-10 h-10 text-muted-foreground/30 mx-auto mb-4" />
                <p className="text-muted-foreground text-sm">No rentals yet.</p>
                <Link href="/marketplace">
                  <Button variant="outline" className="mt-4 font-mono text-xs">BROWSE MARKETPLACE</Button>
                </Link>
              </CardContent>
            </Card>
          ) : history.length === 0 ? (
            <div className="text-sm text-muted-foreground font-mono text-center py-4">NO_HISTORY_YET</div>
          ) : (
            <Card className="bg-card/50 border-border/50 overflow-hidden">
              <div className="divide-y divide-border/50">
                {history.map(rental => (
                  <Link key={rental.id} href={`/rentals/${rental.id}`}>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors cursor-pointer group">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase flex-shrink-0
                          ${rental.status === "completed" ? "bg-green-500/20 text-green-500 border-green-500/30" :
                            rental.status === "pending" ? "bg-yellow-500/20 text-yellow-500 border-yellow-500/30" :
                            "bg-destructive/20 text-destructive border-destructive/30"}`}>
                          {rental.status}
                        </Badge>
                        <div className="min-w-0">
                          <div className="font-medium text-sm group-hover:text-primary transition-colors truncate">{rental.rigName}</div>
                          <div className="text-xs text-muted-foreground">{rental.algorithmName} · {rental.hours}h · {format(new Date(rental.startedAt), "MMM d, yyyy")}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 flex-shrink-0 pl-7 sm:pl-0">
                        <div className="text-right">
                          <div className="text-[10px] text-muted-foreground uppercase font-semibold">Advertised</div>
                          <div className="font-mono text-xs">{formatHashrate(rental.hashrate, rental.algorithmUnit)}</div>
                        </div>
                        {rental.deliveredHashrateAvg !== null && (
                          <div className="text-right min-w-[80px]">
                            <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">Delivered</div>
                            <DeliveryBar ratio={rental.deliveredHashrateAvg / rental.hashrate} />
                          </div>
                        )}
                        <div className="text-right">
                          <div className="font-mono text-sm font-medium">{formatMoney(rental.renterTotalUsd)}</div>
                          <div className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(rental.startedAt), { addSuffix: true })}</div>
                        </div>
                        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
