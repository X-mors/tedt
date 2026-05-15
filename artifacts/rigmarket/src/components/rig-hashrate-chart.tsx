import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate } from "@/lib/format";
import { OwnerRigStats, RigLive } from "@workspace/api-client-react";
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

const RANGE_OPTIONS = [
  { label: '1H',  ms: 3_600_000 },
  { label: '6H',  ms: 6 * 3_600_000 },
  { label: '12H', ms: 12 * 3_600_000 },
  { label: '1D',  ms: 86_400_000 },
  { label: '1W',  ms: 7 * 86_400_000 },
  { label: 'MAX', ms: null },
] as const;

interface Props {
  rigStats: OwnerRigStats;
  rigLive: RigLive | undefined;
}

export function RigHashrateChart({ rigStats, rigLive }: Props) {
  const [rigRange, setRigRange] = useState<number | null>(null);

  // Pool-offline sticky: once purple shows, only clear it after upstreamConnected
  // has been CONTINUOUSLY true for 45 s (≈9 polls). Any single false reading
  // cancels the timer so a retry-cycle flip never dismisses the indicator.
  const [poolOfflineSticky, setPoolOfflineSticky] = useState(false);
  const poolOnlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const uc = rigLive?.upstreamConnected ?? null;
    if (uc === false) {
      if (poolOnlineTimerRef.current) { clearTimeout(poolOnlineTimerRef.current); poolOnlineTimerRef.current = null; }
      setPoolOfflineSticky(true);
    } else if (uc === true) {
      if (!poolOnlineTimerRef.current) {
        poolOnlineTimerRef.current = setTimeout(() => {
          setPoolOfflineSticky(false);
          poolOnlineTimerRef.current = null;
        }, 45_000);
      }
    }
    return () => {};
  }, [rigLive?.upstreamConnected]);

  if (rigStats.samples.length < 2) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Hashrate History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 flex items-center justify-center text-xs font-mono text-muted-foreground">
            NO_DATA_YET — samples appear after the rig produces shares
          </div>
        </CardContent>
      </Card>
    );
  }

  const now    = Date.now();
  const nowMs  = now;

  const filteredRaw = rigRange !== null
    ? rigStats.samples.filter(s => new Date(s.timestamp).getTime() > now - rigRange)
    : rigStats.samples;
  const filtered = filteredRaw.map(s => ({ ...s, ts: new Date(s.timestamp).getTime() }));
  const lastSample = filtered.length > 0 ? filtered[filtered.length - 1] : null;

  // ── Live state ────────────────────────────────────────────────────────────
  const isPoolCurrentlyOffline = poolOfflineSticky;
  const isRigCurrentlyOffline  = rigLive != null && !rigLive.isOnline && !poolOfflineSticky;
  const isCurrentlyRented      = rigLive?.isRented === true;

  // ── Clamp: left edge of visible window ───────────────────────────────────
  const rangeStartMs   = rigRange !== null ? nowMs - rigRange : null;
  const chartDataStart = filtered.length > 0 ? filtered[0].ts : null;
  const clampMs = rangeStartMs
    ?? chartDataStart
    ?? (rigStats.offlinePeriods.length > 0
        ? new Date(rigStats.offlinePeriods[0]!.start).getTime()
        : nowMs - 3_600_000);

  // ── Chart data ────────────────────────────────────────────────────────────
  const liveHashrate = rigLive?.currentHashrate ?? 0;
  const rigChartData = filtered.length > 0
    ? [...filtered, {
        ts: nowMs,
        hashrate: (isRigCurrentlyOffline || isPoolCurrentlyOffline) ? 0 : liveHashrate,
        hasRental: isCurrentlyRented,
        timestamp: new Date(nowMs).toISOString(),
        isPoolOffline: isPoolCurrentlyOffline,
      }]
    : [
        { ts: clampMs, hashrate: 0, hasRental: false, timestamp: new Date(clampMs).toISOString(), isPoolOffline: false },
        { ts: nowMs,   hashrate: 0, hasRental: isCurrentlyRented, timestamp: new Date(nowMs).toISOString(), isPoolOffline: isPoolCurrentlyOffline },
      ];

  // ── 🟡 YELLOW — Rental periods ────────────────────────────────────────────
  // Source : samples with hasRental=true.
  // Live gap: extend ONLY when rigLive.isRented=true (not stale lastSample).
  const rentalRanges: { start: number; end: number }[] = [];
  {
    let runStart: number | null = null;
    let runEnd:   number | null = null;
    for (const s of filtered) {
      if (s.hasRental) {
        if (runStart === null) runStart = s.ts;
        runEnd = s.ts;
      } else if (runStart !== null && runEnd !== null) {
        rentalRanges.push({ start: runStart, end: runEnd });
        runStart = null; runEnd = null;
      }
    }
    if (runStart !== null && runEnd !== null)
      rentalRanges.push({ start: runStart, end: runEnd });
    if (isCurrentlyRented && rentalRanges.length > 0)
      rentalRanges[rentalRanges.length - 1]!.end = nowMs;
    else if (isCurrentlyRented)
      rentalRanges.push({ start: lastSample?.ts ?? clampMs, end: nowMs });
  }

  // ── 🔴 RED — Offline periods ──────────────────────────────────────────────
  // Source : offlinePeriods table (idle + rental).
  // Open period (endedAt=null) → pEnd=nowMs → live.
  // Live gap: rig just disconnected, DB hasn't flushed yet (~60 s).
  //
  // NOTE: pool-offline ranges (🟣) take visual priority. Any red segment that
  // overlaps a purple range is clipped/removed so the pool-offline colour isn't
  // obscured by rapid disconnect/reconnect cycles (each reconnect attempt adds
  // a thin red bar that accumulates into a pink mess beneath the purple layer).
  const rawOfflineRanges: { start: number; end: number }[] = [];
  for (const p of rigStats.offlinePeriods) {
    const pStart = new Date(p.start).getTime();
    const pEnd   = p.end ? new Date(p.end).getTime() : nowMs;
    if (pEnd < clampMs) continue;
    rawOfflineRanges.push({ start: Math.max(pStart, clampMs), end: pEnd });
  }
  if (isRigCurrentlyOffline && lastSample) {
    const covered = rawOfflineRanges.some(r => r.end >= lastSample.ts);
    if (!covered) rawOfflineRanges.push({ start: lastSample.ts, end: nowMs });
  }

  // ── 🟣 PURPLE — Pool offline periods ─────────────────────────────────────
  // Source : samples with isPoolOffline=true.
  // Live gap: poolOfflineSticky && last sample gap not covered.
  const poolOfflineRanges: { start: number; end: number }[] = [];
  {
    let poolRunStart: number | null = null;
    let poolRunEnd:   number | null = null;
    for (const s of filtered) {
      if (s.isPoolOffline) {
        if (poolRunStart === null) poolRunStart = s.ts;
        poolRunEnd = s.ts;
      } else {
        if (poolRunStart !== null && poolRunEnd !== null)
          poolOfflineRanges.push({ start: poolRunStart, end: poolRunEnd });
        poolRunStart = null; poolRunEnd = null;
      }
    }
    if (poolRunStart !== null && poolRunEnd !== null)
      poolOfflineRanges.push({ start: poolRunStart, end: poolRunEnd });
    if (isPoolCurrentlyOffline && lastSample) {
      const covered = poolOfflineRanges.some(r => r.end >= lastSample.ts);
      if (!covered) poolOfflineRanges.push({ start: lastSample.ts, end: nowMs });
    }
  }

  // Merge nearby red ranges: gaps smaller than 60 s (one flush cycle) are
  // caused by rapid disconnect/reconnect retries and should be treated as one
  // continuous offline block to avoid the "thin red bar" visual mess.
  const MERGE_GAP_MS = 60_000;
  const mergedOfflineRanges: { start: number; end: number }[] = [];
  {
    const sorted = [...rawOfflineRanges].sort((a, b) => a.start - b.start);
    for (const r of sorted) {
      const prev = mergedOfflineRanges[mergedOfflineRanges.length - 1];
      if (prev && r.start - prev.end <= MERGE_GAP_MS) {
        prev.end = Math.max(prev.end, r.end);
      } else {
        mergedOfflineRanges.push({ ...r });
      }
    }
  }

  // Clip merged-red ranges against purple: subtract any pool-offline overlap
  // so the purple layer is never obscured by red disconnect bars.
  const offlineRanges: { start: number; end: number }[] = [];
  for (const red of mergedOfflineRanges) {
    const cuts: { start: number; end: number }[] = poolOfflineRanges
      .filter(p => p.start < red.end && p.end > red.start)
      .map(p => ({ start: Math.max(p.start, red.start), end: Math.min(p.end, red.end) }))
      .sort((a, b) => a.start - b.start);
    let cursor = red.start;
    for (const cut of cuts) {
      if (cut.start > cursor) offlineRanges.push({ start: cursor, end: cut.start });
      cursor = cut.end;
    }
    if (cursor < red.end) offlineRanges.push({ start: cursor, end: red.end });
  }

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between">
          <span>Hashrate History</span>
          <div className="flex items-center gap-1">
            {RANGE_OPTIONS.map(opt => (
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
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-green-500" /> Idle</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-yellow-500" /> Rental period</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-red-500" /> Offline</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-purple-500" /> Pool offline</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-48 bg-background/30 rounded-md border border-border/30 px-2 py-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rigChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="rigHashrateFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
              <YAxis
                hide
                domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, rigStats.advertisedHashrate * 1.05)]}
              />
              {rentalRanges.map((r, i) => (
                <ReferenceArea key={`rent-${i}`} x1={r.start} x2={r.end} fill="#f0b90b" fillOpacity={0.18} stroke="none" ifOverflow="extendDomain" />
              ))}
              {offlineRanges.map((r, i) => (
                <ReferenceArea key={`off-${i}`} x1={r.start} x2={r.end} fill="#ef4444" fillOpacity={0.18} stroke="none" ifOverflow="extendDomain" />
              ))}
              {poolOfflineRanges.map((r, i) => (
                <ReferenceArea key={`pool-${i}`} x1={r.start} x2={r.end} fill="#a855f7" fillOpacity={0.22} stroke="none" ifOverflow="extendDomain" />
              ))}
              <Tooltip
                cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
                contentStyle={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 8px' }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                formatter={(v: number, _n, item) => [
                  formatHashrate(v, rigStats.algorithmUnit) + (item?.payload?.hasRental ? ' · rental' : ' · idle'),
                  'Hashrate',
                ]}
                labelFormatter={(t: number) => new Date(t).toLocaleString()}
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
      </CardContent>
    </Card>
  );
}
