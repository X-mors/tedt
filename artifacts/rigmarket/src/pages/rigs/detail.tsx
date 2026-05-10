import { useState } from "react";
import { useParams, Link } from "wouter";
import { useGetRig, useGetMyRig, getGetMyRigQueryKey, useListRigReviews, useGetMe, useGetRigStats, getGetRigStatsQueryKey, useGetRigLive } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Server, Activity, MapPin, Clock, Star, ShieldCheck, Cpu } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { format } from "date-fns";
import {
  Area,
  AreaChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const RIG_RANGE_OPTIONS = [
  { label: '1H',  ms: 3_600_000 },
  { label: '6H',  ms: 6 * 3_600_000 },
  { label: '12H', ms: 12 * 3_600_000 },
  { label: '1D',  ms: 86_400_000 },
  { label: '1W',  ms: 7 * 86_400_000 },
  { label: 'MAX', ms: null },
] as const;

export default function RigDetail() {
  const { id } = useParams<{ id: string }>();
  const rigId = parseInt(id || "0");
  const [rigRange, setRigRange] = useState<number | null>(null);
  
  const { data: rig, isLoading } = useGetRig(rigId);
  const { data: reviews } = useListRigReviews(rigId);
  const { data: me } = useGetMe();

  const isOwner = !!(me && rig && me.id === rig.ownerId);
  // When the viewer is the owner, also fetch from the owner-specific endpoint
  // so hasFallbackPool reflects the actual fallback pool configuration.
  const { data: myRig } = useGetMyRig(rigId, { query: { enabled: isOwner, queryKey: getGetMyRigQueryKey(rigId) } });
  // Public 14-day hashrate history. Visible to all visitors (logged in or
  // not). Refresh every 60s so a new flush becomes visible without a hard
  // reload.
  const { data: rigStats } = useGetRigStats(rigId, {
    query: { refetchInterval: 60_000, queryKey: getGetRigStatsQueryKey(rigId) },
  });
  // Live telemetry: current hashrate + share difficulty. Public, no auth needed.
  const { data: rigLive } = useGetRigLive(rigId, {
    query: { refetchInterval: 5_000, enabled: !!rigId, queryKey: [`/api/rigs/${rigId}/live`] },
  });

  // Group consecutive samples sharing the same rental state into contiguous
  // [start, end] timestamp ranges so we can shade rental periods yellow with
  // a single ReferenceArea per range instead of one per sample.
  const rentalRanges: { start: string; end: string }[] = [];
  if (rigStats?.samples) {
    let runStart: string | null = null;
    let runEnd: string | null = null;
    for (const s of rigStats.samples) {
      if (s.hasRental) {
        if (runStart === null) runStart = s.timestamp;
        runEnd = s.timestamp;
      } else if (runStart !== null && runEnd !== null) {
        rentalRanges.push({ start: runStart, end: runEnd });
        runStart = null;
        runEnd = null;
      }
    }
    if (runStart !== null && runEnd !== null) {
      rentalRanges.push({ start: runStart, end: runEnd });
    }
  }

  if (isLoading) {
    return <div className="p-8 text-center font-mono text-muted-foreground">LOADING_RIG_DATA...</div>;
  }

  if (!rig) return <div className="p-8 text-center font-mono text-destructive">RIG_NOT_FOUND</div>;

  const ownerIsOnline = myRig?.isOnline ?? rig.isOnline;
  const hasFallbackPool = myRig?.hasFallbackPool ?? false;

  // Effective status: rig.status is the persisted DB column, refreshed by a
  // 5-minute background sync. If the miner is connected RIGHT NOW we treat an
  // "offline" record as "available" so the page doesn't show OFFLINE next to
  // ONLINE · IDLE (and the rent button doesn't show UNAVAILABLE for a rig that
  // is clearly mineable). "rented" and "paused" are owner/system states and
  // override the live signal.
  const effectiveStatus =
    ownerIsOnline && rig.status === 'offline' ? 'available' : rig.status;
  const isRentable = effectiveStatus === 'available';

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">{rig.name}</h1>
            <Badge variant={effectiveStatus === 'available' ? 'default' : effectiveStatus === 'rented' ? 'secondary' : 'destructive'}
                   className={`font-mono text-xs uppercase ${effectiveStatus === 'available' ? 'bg-primary/20 text-primary border-primary/30' : ''}`}>
              {effectiveStatus}
            </Badge>
            {ownerIsOnline && effectiveStatus !== 'rented' && hasFallbackPool && (
              <Badge variant="outline" className="font-mono text-xs uppercase bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                MINING FALLBACK
              </Badge>
            )}
            {ownerIsOnline && effectiveStatus !== 'rented' && !hasFallbackPool && (
              <Badge variant="outline" className="font-mono text-xs uppercase bg-green-500/10 text-green-500 border-green-500/30">
                ONLINE · IDLE
              </Badge>
            )}
            {ownerIsOnline && effectiveStatus === 'rented' && (
              <Badge variant="outline" className="font-mono text-xs uppercase bg-green-500/10 text-green-500 border-green-500/30">
                CONNECTED
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><Server className="w-4 h-4" /> {rig.ownerDisplayName}</span>
            <span className="flex items-center gap-1"><MapPin className="w-4 h-4" /> {rig.region}</span>
            <span className="flex items-center gap-1"><Activity className="w-4 h-4" /> {rig.totalRentals} rentals</span>
            {rig.averageRating && <span className="flex items-center gap-1 text-yellow-500 font-mono"><Star className="w-4 h-4 fill-current" /> {rig.averageRating.toFixed(1)}</span>}
          </div>
        </div>
        
        {isRentable && rig.ownerId !== me?.id && (
          <Link href={`/rentals/new/${rig.id}`}>
            <Button size="lg" className="font-mono text-sm bg-primary text-primary-foreground hover:bg-primary/90 w-full md:w-auto">
              INITIATE_RENTAL
            </Button>
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg">Specifications</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground uppercase font-semibold">Algorithm</span>
                  <div className="font-medium flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary"></span>
                    {rig.algorithmName}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground uppercase font-semibold">Hashrate</span>
                  <div className="font-mono text-primary font-bold text-lg">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground uppercase font-semibold">Min Duration</span>
                  <div className="font-mono">{rig.minRentalHours}h</div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground uppercase font-semibold">Max Duration</span>
                  <div className="font-mono">{rig.maxRentalHours}h</div>
                </div>
              </div>
              
              <Separator className="bg-border/50" />
              
              <div>
                <span className="text-xs text-muted-foreground uppercase font-semibold block mb-2">Description</span>
                <p className="text-sm whitespace-pre-wrap">{rig.description}</p>
              </div>
            </CardContent>
          </Card>

          {rigLive && (
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">Live Telemetry</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                    <span className="text-[10px] text-muted-foreground uppercase font-semibold">Current Hashrate</span>
                    <span className="font-mono text-lg font-bold text-primary">
                      {rigLive.currentHashrateH > 0 ? formatHashrate(rigLive.currentHashrate, rigLive.algorithmUnit) : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">live · 5s refresh</span>
                  </div>
                  <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                    <span className="text-[10px] text-muted-foreground uppercase font-semibold">Share Difficulty</span>
                    <span className="font-mono text-lg font-bold">
                      {rigLive.currentDifficulty > 1 ? rigLive.currentDifficulty.toLocaleString() : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">pool target</span>
                  </div>
                  <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                    <span className="text-[10px] text-muted-foreground uppercase font-semibold flex items-center gap-1">
                      <Cpu className="w-3 h-3" /> Workers
                    </span>
                    <span className="font-mono text-lg font-bold text-cyan-400">
                      {rigLive.workerCount > 0 ? rigLive.workerCount : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60 mt-1 font-mono">connected devices</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {rigStats && (
            <Card className="bg-card/50 border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span>Hashrate History</span>
                  <div className="flex items-center gap-1">
                    {RIG_RANGE_OPTIONS.map(opt => (
                      <button
                        key={opt.label}
                        onClick={() => setRigRange(opt.ms ?? null)}
                        className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                          rigRange === (opt.ms ?? null)
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </CardTitle>
                <CardDescription className="text-xs flex items-center gap-3 pt-1">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-green-500" /> Idle
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-yellow-500" /> Rental period
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-red-500" /> Offline
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-purple-500" /> Pool issue
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                {rigStats.samples.length > 1 ? (() => {
                  const now = Date.now();
                  const filtered = rigRange !== null
                    ? rigStats.samples.filter(s => new Date(s.timestamp).getTime() > now - rigRange)
                    : rigStats.samples;
                  const nowStr = new Date().toISOString();
                  const lastSample = filtered.length > 0 ? filtered[filtered.length - 1] : null;

                  // Historical gap ranges: gaps > 90 s between consecutive samples
                  // mean the rig was offline (no shares, no pool-disconnect sample written).
                  // Historical pool-disconnect ranges: consecutive samples with poolConnected=false
                  // written by the flush loop when miner was up but pool was down.
                  const gapRanges: { start: string; end: string }[] = [];
                  const poolDisconnectRanges: { start: string; end: string }[] = [];
                  const GAP_THRESHOLD_MS = 90_000;
                  let pdStart: string | null = null;
                  for (let gi = 0; gi < filtered.length; gi++) {
                    const s = filtered[gi];
                    // pool disconnect ranges
                    if (!s.poolConnected) {
                      if (!pdStart) pdStart = s.timestamp;
                    } else if (pdStart) {
                      poolDisconnectRanges.push({ start: pdStart, end: s.timestamp });
                      pdStart = null;
                    }
                    // gap (rig offline) ranges
                    if (gi < filtered.length - 1) {
                      const t1 = new Date(s.timestamp).getTime();
                      const t2 = new Date(filtered[gi + 1]!.timestamp).getTime();
                      if (t2 - t1 > GAP_THRESHOLD_MS) {
                        gapRanges.push({ start: s.timestamp, end: filtered[gi + 1]!.timestamp });
                      }
                    }
                  }

                  const isPoolDisconnected = ownerIsOnline &&
                    rigLive != null &&
                    rigLive.workerCount > 0 &&
                    (!rigLive.upstreamConnected || rigLive.poolAuthFailed) &&
                    rentalRanges.length > 0;
                  const rigChartData = !ownerIsOnline && filtered.length > 0
                    ? [...filtered, { timestamp: nowStr, hashrate: 0, hasRental: false }]
                    : filtered;
                  return (
                  <div className="h-48 bg-background/30 rounded-md border border-border/30 px-2 py-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={rigChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="rigHashrateFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
                            <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="timestamp" hide />
                        <YAxis
                          hide
                          domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, rigStats.advertisedHashrate * 1.05)]}
                        />
                        {/* Historical rental periods — yellow */}
                        {rentalRanges.map((r, i) => (
                          <ReferenceArea
                            key={`rent-${i}`}
                            x1={r.start}
                            x2={r.end}
                            fill="#f0b90b"
                            fillOpacity={0.18}
                            stroke="none"
                            ifOverflow="extendDomain"
                          />
                        ))}
                        {/* Historical offline gaps — red (persists after reconnection) */}
                        {gapRanges.map((r, i) => (
                          <ReferenceArea
                            key={`gap-${i}`}
                            x1={r.start}
                            x2={r.end}
                            fill="#ef4444"
                            fillOpacity={0.14}
                            stroke="none"
                            ifOverflow="extendDomain"
                          />
                        ))}
                        {/* Historical pool-disconnect periods — purple */}
                        {poolDisconnectRanges.map((r, i) => (
                          <ReferenceArea
                            key={`pd-${i}`}
                            x1={r.start}
                            x2={r.end}
                            fill="#a855f7"
                            fillOpacity={0.18}
                            stroke="none"
                            ifOverflow="extendDomain"
                          />
                        ))}
                        {/* Current live state: offline or pool issue → extends to now */}
                        {!ownerIsOnline && lastSample && (
                          <ReferenceArea
                            x1={lastSample.timestamp}
                            x2={nowStr}
                            fill="#ef4444"
                            fillOpacity={0.18}
                            stroke="none"
                            ifOverflow="extendDomain"
                          />
                        )}
                        {isPoolDisconnected && lastSample && (
                          <ReferenceArea
                            x1={lastSample.timestamp}
                            x2={nowStr}
                            fill="#a855f7"
                            fillOpacity={0.22}
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
                          formatter={(v: number, _n, item) => [
                            formatHashrate(v, rigStats.algorithmUnit) +
                              (item?.payload?.hasRental ? ' · rental' : ' · idle'),
                            'Hashrate',
                          ]}
                          labelFormatter={(t: string) => new Date(t).toLocaleString()}
                        />
                        <ReferenceLine
                          y={rigStats.advertisedHashrate}
                          stroke="#ef4444"
                          strokeDasharray="5 4"
                          strokeWidth={1.5}
                          label={{ value: formatHashrate(rigStats.advertisedHashrate, rigStats.algorithmUnit), position: 'insideTopRight', fontSize: 9, fill: '#ef4444', fontFamily: 'var(--font-mono)' }}
                          ifOverflow="extendDomain"
                        />
                        <Area
                          type="monotone"
                          dataKey="hashrate"
                          stroke="#22c55e"
                          strokeWidth={1.6}
                          fill="url(#rigHashrateFill)"
                          isAnimationActive={false}
                          dot={false}
                          activeDot={{ r: 3, fill: '#22c55e', stroke: 'hsl(var(--background))', strokeWidth: 1.5 }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  );
                })() : (
                  <div className="h-48 flex items-center justify-center text-xs font-mono text-muted-foreground">
                    NO_DATA_YET — samples appear after the rig produces shares
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg">Recent Reviews ({rig.reviewCount})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {reviews?.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4 font-mono">NO_REVIEWS_YET</div>
              ) : (
                reviews?.map(review => (
                  <div key={review.id} className="space-y-2 pb-4 border-b border-border/50 last:border-0 last:pb-0">
                    <div className="flex justify-between items-start">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {review.renterDisplayName}
                        <ShieldCheck className="w-3 h-3 text-primary" />
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{format(new Date(review.createdAt), "MMM d, yyyy")}</div>
                    </div>
                    <div className="flex gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={`w-3 h-3 ${i < review.rating ? 'text-yellow-500 fill-current' : 'text-muted'}`} />
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">{review.body}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-secondary/20 border-primary/20 sticky top-20">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Pricing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Rate</span>
                <div className="text-3xl font-mono font-bold flex items-baseline gap-1">
                  {formatMoney(rig.pricePerUnitPerHour)}
                  <span className="text-sm font-sans font-normal text-muted-foreground">/ hr</span>
                </div>
              </div>
              
              <div className="space-y-2 bg-background/50 p-3 rounded-md border border-border/50">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Total Hashrate</span>
                  <span className="font-mono">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Algorithm</span>
                  <span>{rig.algorithmName}</span>
                </div>
              </div>

              {isRentable ? (
                rig.ownerId === me?.id ? (
                  <Button disabled className="w-full font-mono">YOUR_RIG</Button>
                ) : (
                  <Link href={`/rentals/new/${rig.id}`}>
                    <Button className="w-full font-mono bg-primary text-primary-foreground hover:bg-primary/90">RENT_NOW</Button>
                  </Link>
                )
              ) : (
                <Button disabled variant="secondary" className="w-full font-mono">UNAVAILABLE</Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
