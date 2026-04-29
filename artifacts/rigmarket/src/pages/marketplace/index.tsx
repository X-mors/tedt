import { useState } from "react";
import { useListRigs, useListAlgorithms } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Server, Activity, Zap } from "lucide-react";

export default function Marketplace() {
  const [search, setSearch] = useState("");
  const [algorithmId, setAlgorithmId] = useState<number | undefined>();
  const [status, setStatus] = useState<"available" | "rented" | "offline" | undefined>();
  const [sort, setSort] = useState<"price_asc" | "price_desc" | "hashrate_desc" | "newest" | "rating_desc">("newest");

  const { data: algorithms } = useListAlgorithms();
  const { data: rigs, isLoading } = useListRigs({
    search: search || undefined,
    algorithmId,
    status,
    sort,
  });

  const available = rigs?.filter(r => r.status === "available") ?? [];
  const rented = rigs?.filter(r => r.status === "rented") ?? [];
  const online = rigs?.filter(r => r.isOnline) ?? [];

  return (
    <div className="container py-8 px-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground">Browse and rent available compute</p>
        </div>
        <Link href="/marketplace/algorithms" className="text-sm font-mono bg-secondary text-secondary-foreground px-4 py-2 rounded hover:bg-secondary/80 transition-colors">
          ALGORITHM_CATALOG
        </Link>
      </div>

      {/* Market stats strip */}
      {!isLoading && rigs && rigs.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-card/50 border border-border/50 rounded-lg p-3 flex items-center gap-3">
            <Zap className="w-4 h-4 text-primary flex-shrink-0" />
            <div>
              <div className="font-mono font-bold text-lg">{available.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Available Rigs</div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-3 flex items-center gap-3">
            <Activity className="w-4 h-4 text-secondary-foreground flex-shrink-0" />
            <div>
              <div className="font-mono font-bold text-lg">{rented.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Currently Rented</div>
            </div>
          </div>
          <div className="bg-card/50 border border-border/50 rounded-lg p-3 flex items-center gap-3">
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <div>
              <div className="font-mono font-bold text-lg text-green-500">{online.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Online Now</div>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by rig name or owner..."
              className="pl-9 font-mono text-sm bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Select value={algorithmId?.toString() || "all"} onValueChange={(v) => setAlgorithmId(v === "all" ? undefined : parseInt(v))}>
            <SelectTrigger className="w-full md:w-[200px] font-mono text-sm bg-background">
              <SelectValue placeholder="Algorithm" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ALL_ALGORITHMS</SelectItem>
              {algorithms?.map(a => (
                <SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? undefined : (v as "available" | "rented" | "offline"))}>
            <SelectTrigger className="w-full md:w-[160px] font-mono text-sm bg-background">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ALL_STATUS</SelectItem>
              <SelectItem value="available">AVAILABLE</SelectItem>
              <SelectItem value="rented">RENTED</SelectItem>
              <SelectItem value="offline">OFFLINE</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(v) => setSort(v as "price_asc" | "price_desc" | "hashrate_desc" | "newest" | "rating_desc")}>
            <SelectTrigger className="w-full md:w-[180px] font-mono text-sm bg-background">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">NEWEST_FIRST</SelectItem>
              <SelectItem value="price_asc">PRICE_LOW_HIGH</SelectItem>
              <SelectItem value="price_desc">PRICE_HIGH_LOW</SelectItem>
              <SelectItem value="hashrate_desc">HASHRATE_HIGH_LOW</SelectItem>
              <SelectItem value="rating_desc">TOP_RATED</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <Card key={i} className="animate-pulse bg-muted/20">
              <CardHeader className="h-24" />
              <CardContent className="h-20" />
            </Card>
          ))}
        </div>
      ) : rigs?.length === 0 ? (
        <div className="text-center py-20 border border-dashed rounded-lg bg-muted/10">
          <Server className="mx-auto h-10 w-10 text-muted-foreground opacity-50 mb-4" />
          <h3 className="text-lg font-medium">No rigs found</h3>
          <p className="text-sm text-muted-foreground mt-1">Try adjusting your filters or search query.</p>
          <Button variant="outline" className="mt-4 font-mono text-xs" onClick={() => {
            setSearch(""); setAlgorithmId(undefined); setStatus(undefined); setSort("newest");
          }}>
            RESET_FILTERS
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {rigs?.map(rig => (
            <Link key={rig.id} href={`/rigs/${rig.id}`}>
              <Card className="group hover:border-primary/50 transition-all cursor-pointer h-full flex flex-col bg-card/40 hover:bg-card/80">
                <CardHeader className="pb-3 flex-none">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={rig.status === "available" ? "default" : rig.status === "rented" ? "secondary" : "destructive"}
                        className={`font-mono text-[10px] uppercase ${rig.status === "available" ? "bg-primary/20 text-primary border-primary/30 hover:bg-primary/30" : ""}`}
                      >
                        {rig.status}
                      </Badge>
                      {rig.isOnline && (
                        <span title="Miner is online" className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                        </span>
                      )}
                    </div>
                    {rig.averageRating && (
                      <span className="text-xs text-yellow-500 flex items-center font-mono gap-0.5">
                        ★ {rig.averageRating.toFixed(1)}
                        <span className="text-muted-foreground">({rig.reviewCount})</span>
                      </span>
                    )}
                  </div>
                  <CardTitle className="text-lg truncate group-hover:text-primary transition-colors">{rig.name}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <Server className="w-3 h-3" /> {rig.ownerDisplayName}
                  </p>
                </CardHeader>
                <CardContent className="mt-auto pt-4 border-t border-border/40 space-y-3">
                  <div className="flex justify-between items-end">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Algorithm</span>
                      <span className="text-sm font-medium">{rig.algorithmName}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Hashrate</span>
                      <span className="text-sm font-mono text-primary font-bold">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-end pt-2">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Min/Max</span>
                      <span className="text-sm font-mono text-muted-foreground">{rig.minRentalHours}h - {rig.maxRentalHours}h</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Price/hr</span>
                      <span className="text-lg font-mono font-medium">{formatMoney(rig.pricePerUnitPerHour * rig.hashrate)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
