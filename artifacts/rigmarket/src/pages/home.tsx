import { useGetMarketplaceSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Link } from "wouter";
import { Server, Activity, Users, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  const { data: summary, isLoading } = useGetMarketplaceSummary();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <Server className="h-8 w-8 text-primary opacity-50" />
          <div className="text-sm text-muted-foreground font-mono">INITIALIZING_DASHBOARD...</div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="container py-10 px-4 max-w-6xl mx-auto space-y-10">
      <section className="flex flex-col items-center text-center space-y-4 py-12 md:py-20 border-b border-border/50">
        <Badge variant="outline" className="px-3 py-1 font-mono bg-primary/5 text-primary border-primary/20">
          SYSTEM_ONLINE
        </Badge>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tighter">
          Command Center for <br />
          <span className="text-primary">Hashpower Trading</span>
        </h1>
        <p className="text-muted-foreground max-w-[600px] text-lg md:text-xl">
          Rent bare-metal mining rigs by the hour. Point real workloads at verified hardware. No cloud contracts, pure compute.
        </p>
        <div className="flex gap-4 pt-4">
          <Link href="/marketplace" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-8 py-2 font-mono">
            ENTER_MARKETPLACE <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/sign-up" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-8 py-2 font-mono">
            INITIALIZE_ACCOUNT
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card/50 border-border/50 backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">Available Compute</CardTitle>
            <Server className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{summary.availableRigs}</div>
            <p className="text-xs text-muted-foreground mt-1">Ready for deployment</p>
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50 backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Workloads</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{summary.activeRentals}</div>
            <p className="text-xs text-muted-foreground mt-1">Currently hashing</p>
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50 backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network Participants</CardTitle>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{summary.totalLessors + summary.totalRenters}</div>
            <p className="text-xs text-muted-foreground mt-1">Verified operators</p>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight">Top Hardware Available</h2>
          <Link href="/marketplace" className="text-sm font-mono text-primary hover:underline flex items-center gap-1">
            VIEW_ALL <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {summary.topRigs.slice(0, 3).map(rig => (
            <Card key={rig.id} className="group hover:border-primary/50 transition-colors flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-lg truncate">{rig.name}</CardTitle>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-green-500"></span>
                      {rig.algorithmName}
                    </div>
                  </div>
                  <Badge variant="outline" className="font-mono bg-primary/5">
                    {formatHashrate(rig.hashrate, rig.algorithmUnit)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="mt-auto pt-4 border-t border-border/50 flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground uppercase font-semibold">Rate/hr</span>
                  <span className="font-mono font-medium">{formatMoney(rig.pricePerUnitPerHour)} / {rig.algorithmUnit}</span>
                </div>
                <Link href={`/rigs/${rig.id}`} className="text-sm font-mono bg-secondary text-secondary-foreground hover:bg-secondary/80 px-4 py-2 rounded transition-colors">
                  INSPECT
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
