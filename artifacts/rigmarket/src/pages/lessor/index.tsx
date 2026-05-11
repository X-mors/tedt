import { useState, useEffect } from "react";
import { useListMyRigs, useListLessorRentals, useDeleteMyRig, getListMyRigsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { isPast } from "date-fns";
import {
  Server, Plus, Edit2, Trash2, Activity, Cpu, DollarSign,
  ArrowRight, Clock, TrendingUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

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
      <div className="w-16 h-1.5 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono ${pct >= 95 ? "text-green-500" : pct >= 80 ? "text-yellow-500" : "text-destructive"}`}>
        {pct}%
      </span>
    </div>
  );
}

export default function LessorDashboard() {
  const { data: rigs, isLoading: rigsLoading } = useListMyRigs({ query: { refetchInterval: 5 * 60_000, queryKey: getListMyRigsQueryKey() } });
  const { data: rentals, isLoading: rentalsLoading } = useListLessorRentals();
  const deleteRig = useDeleteMyRig();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleDeleteRig = (id: number, name: string) => {
    if (confirm(`Are you sure you want to delete rig "${name}"? This action cannot be undone.`)) {
      deleteRig.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Rig Deleted", description: `Rig ${name} has been removed.` });
          queryClient.invalidateQueries({ queryKey: getListMyRigsQueryKey() });
        },
        onError: (err) => {
          toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const activeRentals = rentals?.filter(r => r.status === "active") ?? [];
  const totalEarnings = rentals?.reduce((s, r) => s + r.ownerEarningsUsd, 0) ?? 0;
  const onlineRigs = rigs?.filter(r => r.isOnline).length ?? 0;

  return (
    <div className="container py-8 px-4 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Owner Inventory</h1>
          <p className="text-muted-foreground">Manage your hardware and monitor incoming workloads</p>
        </div>
        <Link href="/lessor/rigs/new">
          <Button className="font-mono text-sm bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2">
            <Plus className="w-4 h-4" /> ADD_RIG
          </Button>
        </Link>
      </div>

      {/* Summary strip */}
      {!rigsLoading && rigs && rigs.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <Cpu className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold">{rigs.length}</div>
              <div className="text-xs text-muted-foreground uppercase">
                Rigs · <span className="text-green-500">{onlineRigs} online</span>
              </div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <Activity className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold text-primary">{activeRentals.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Active Leases</div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-green-500 flex-shrink-0" />
            <div>
              <div className="text-2xl font-mono font-bold text-green-500">{formatMoney(totalEarnings)}</div>
              <div className="text-xs text-muted-foreground uppercase">Total Earned</div>
            </div>
          </div>
        </div>
      )}

      <Tabs defaultValue="rigs" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto">
          <TabsTrigger value="rigs" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">
            My Hardware
          </TabsTrigger>
          <TabsTrigger value="rentals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">
            Active & Past Leases
            {activeRentals.length > 0 && (
              <span className="ml-2 bg-primary text-primary-foreground text-[10px] font-mono px-1.5 py-0.5 rounded-full">
                {activeRentals.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rigs" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">NAME</TableHead>
                    <TableHead className="font-mono text-xs">STATUS</TableHead>
                    <TableHead className="font-mono text-xs">ALGORITHM</TableHead>
                    <TableHead className="font-mono text-xs text-right">HASHRATE</TableHead>
                    <TableHead className="font-mono text-xs text-right">RATE/HR</TableHead>
                    <TableHead className="font-mono text-xs text-right">ACTIONS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rigsLoading ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_INVENTORY...</TableCell>
                    </TableRow>
                  ) : rigs?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                        No rigs found. <Link href="/lessor/rigs/new" className="text-primary hover:underline">Add a rig</Link> to start earning.
                      </TableCell>
                    </TableRow>
                  ) : rigs?.map(rig => {
                    const activeRental = activeRentals.find(r => r.rigId === rig.id);
                    return (
                      <TableRow key={rig.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <span title={rig.isOnline ? "Online" : "Offline"} className="relative flex h-2 w-2 flex-shrink-0">
                              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${rig.isOnline ? "bg-green-500" : "bg-red-500"}`} />
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${rig.isOnline ? "bg-green-500" : "bg-red-500"}`} />
                            </span>
                            <div className="flex flex-col">
                              <Link href={`/rigs/${rig.id}`} className="hover:text-primary transition-colors">{rig.name}</Link>
                              {rig.stratumName ? (
                                <span className="text-[10px] font-mono text-muted-foreground">worker: {rig.stratumName}</span>
                              ) : (
                                <span className="text-[10px] font-mono text-muted-foreground/50">no stratum name</span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {rig.approvalStatus === "pending" && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-orange-500/10 text-orange-500 border-orange-500/30">
                                PENDING REVIEW
                              </Badge>
                            )}
                            {rig.approvalStatus === "rejected" && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-destructive/10 text-destructive border-destructive/30">
                                REJECTED
                              </Badge>
                            )}
                            <Badge variant="outline" className={`font-mono text-[10px] uppercase w-fit
                              ${!rig.isOnline && rig.poolOffline
                                ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                                : !rig.isOnline
                                ? "bg-destructive/20 text-destructive border-destructive/30"
                                : rig.status === "rented"
                                ? "bg-secondary/50 text-secondary-foreground border-secondary"
                                : "bg-primary/20 text-primary border-primary/30"}`}>
                              {!rig.isOnline && rig.poolOffline
                                ? "POOL OFFLINE"
                                : !rig.isOnline
                                ? "OFFLINE"
                                : rig.status === "rented"
                                ? "RENTED"
                                : "AVAILABLE"}
                            </Badge>
                            {rig.isOnline && rig.poolOffline === true && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-purple-500/20 text-purple-400 border-purple-500/30">
                                POOL OFFLINE
                              </Badge>
                            )}
                            {rig.isOnline && rig.status !== "rented" && rig.hasFallbackPool && rig.poolOffline !== true && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                                MINING FALLBACK
                              </Badge>
                            )}
                            {rig.isOnline && rig.status !== "rented" && !rig.hasFallbackPool && rig.poolOffline !== true && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-green-500/10 text-green-500 border-green-500/30">
                                ONLINE · IDLE
                              </Badge>
                            )}
                            {rig.isOnline && rig.status === "rented" && rig.poolOffline !== true && (
                              <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-green-500/10 text-green-500 border-green-500/30">
                                CONNECTED
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{rig.algorithmName}</TableCell>
                        <TableCell className="text-right font-mono font-medium">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</TableCell>
                        <TableCell className="text-right font-mono">{formatMoney(rig.pricePerUnitPerHour)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2 items-center">
                            {activeRental && (
                              <Link href={`/rentals/${activeRental.id}`}>
                                <Button variant="outline" size="sm" className="font-mono text-[10px] h-7 px-2 gap-1 text-primary border-primary/30 hover:border-primary">
                                  <Activity className="w-3 h-3" />
                                  LIVE
                                </Button>
                              </Link>
                            )}
                            <Link href={`/lessor/rigs/${rig.id}/edit`}>
                              <Button variant="ghost" size="icon" className="h-8 w-8"><Edit2 className="w-4 h-4" /></Button>
                            </Link>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => handleDeleteRig(rig.id, rig.name)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rentals" className="pt-6 space-y-4">
          {/* Active leases highlighted section */}
          {activeRentals.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Live Leases</h3>
              </div>
              {activeRentals.map(rental => (
                <Card key={rental.id} className="bg-card/50 border-primary/20">
                  <CardContent className="p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm">{rental.rigName}</div>
                        <div className="text-xs text-muted-foreground">{rental.algorithmName} · {rental.hours}h rental</div>
                        <div className="text-xs text-muted-foreground mt-0.5">Renter: {rental.renterDisplayName}</div>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-center sm:text-right flex-shrink-0 text-sm">
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Hashrate</div>
                          <div className="font-mono text-primary">{formatHashrate(rental.hashrate, rental.algorithmUnit)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Time Left</div>
                          <div className="flex items-center justify-center sm:justify-end gap-1">
                            <Clock className="w-3 h-3 text-primary" />
                            <LiveCountdown endsAt={rental.endsAt} />
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Earnings</div>
                          <div className="font-mono text-green-500">+{formatMoney(rental.ownerEarningsUsd)}</div>
                        </div>
                      </div>
                      <Link href={`/rentals/${rental.id}`}>
                        <Button size="sm" variant="outline" className="font-mono text-xs gap-1 border-primary/30 text-primary hover:border-primary w-full sm:w-auto">
                          <Activity className="w-3 h-3" />
                          COCKPIT
                          <ArrowRight className="w-3 h-3" />
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* History table */}
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">ID</TableHead>
                    <TableHead className="font-mono text-xs">STATUS</TableHead>
                    <TableHead className="font-mono text-xs">RIG</TableHead>
                    <TableHead className="font-mono text-xs">RENTER</TableHead>
                    <TableHead className="font-mono text-xs text-right">DELIVERED</TableHead>
                    <TableHead className="font-mono text-xs text-right">DURATION</TableHead>
                    <TableHead className="font-mono text-xs text-right">EARNINGS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rentalsLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_LEASES...</TableCell>
                    </TableRow>
                  ) : rentals?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No lease history found.</TableCell>
                    </TableRow>
                  ) : rentals?.filter(r => r.status !== "active").map(rental => (
                    <TableRow key={rental.id} className="cursor-pointer hover:bg-muted/20" onClick={() => window.location.href = `/rentals/${rental.id}`}>
                      <TableCell className="font-mono text-xs text-muted-foreground">#{rental.id}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase
                          ${rental.status === "completed" ? "bg-green-500/20 text-green-500 border-green-500/30" :
                            rental.status === "pending" ? "bg-yellow-500/20 text-yellow-500 border-yellow-500/30" :
                            "bg-destructive/20 text-destructive border-destructive/30"}`}>
                          {rental.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium text-sm">{rental.rigName}</TableCell>
                      <TableCell className="text-sm">{rental.renterDisplayName}</TableCell>
                      <TableCell className="text-right">
                        {rental.deliveredHashrateAvg !== null ? (
                          <DeliveryBar ratio={rental.deliveredHashrateAvg / rental.hashrate} />
                        ) : (
                          <span className="text-xs text-muted-foreground font-mono">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{rental.hours}h</TableCell>
                      <TableCell className="text-right font-mono font-medium text-green-500">+{formatMoney(rental.ownerEarningsUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
