import { useState, useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useGetRig, useCreateRentalQuote, useCreateRental, useGetMe, useTestPoolConnection, useListMyPools } from "@workspace/api-client-react";
import { SaveAsPoolButton } from "@/components/save-as-pool-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { Server, Activity, Clock, ShieldAlert, WifiOff, AlertTriangle, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export default function NewRental() {
  const { rigId: rigIdParam } = useParams<{ rigId: string }>();
  const rigId = parseInt(rigIdParam || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: rig, isLoading: rigLoading } = useGetRig(rigId);
  const { data: me } = useGetMe();
  const { data: savedPools } = useListMyPools();

  const [hours, setHours] = useState(1);
  const [poolUrl, setPoolUrl] = useState("");
  const [poolWorker, setPoolWorker] = useState("");
  const [poolPassword, setPoolPassword] = useState("");

  const createQuote = useCreateRentalQuote();
  const createRental = useCreateRental();
  const testPool = useTestPoolConnection();
  const [poolTestResult, setPoolTestResult] = useState<{
    success: boolean;
    authFailed: boolean;
    message: string;
    latencyMs: number | null;
  } | null>(null);

  useEffect(() => {
    if (rig) {
      setHours(rig.minRentalHours);
    }
  }, [rig]);

  useEffect(() => {
    if (rigId && hours >= (rig?.minRentalHours || 1)) {
      const timer = setTimeout(() => {
        createQuote.mutate({ data: { rigId, hours } });
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [rigId, hours, rig?.minRentalHours]);

  const handleTestPool = () => {
    if (!poolUrl || !poolWorker) {
      toast({ title: "Enter pool URL and worker first", variant: "destructive" });
      return;
    }
    setPoolTestResult(null);
    testPool.mutate(
      { data: { poolUrl, poolWorker, poolPassword: poolPassword || "x" } },
      {
        onSuccess: (result) => setPoolTestResult(result),
        onError: (err) => setPoolTestResult({ success: false, authFailed: false, message: err.message, latencyMs: null }),
      },
    );
  };

  const handleDeploy = () => {
    if (!poolUrl || !poolWorker) {
      toast({ title: "Validation Error", description: "Pool URL and Worker are required", variant: "destructive" });
      return;
    }

    if (me && createQuote.data && me.balanceUsd < createQuote.data.renterTotalUsd) {
      toast({ title: "Insufficient Funds", description: "Please deposit more funds to your wallet", variant: "destructive" });
      return;
    }

    createRental.mutate({
      data: {
        rigId,
        hours,
        poolUrl,
        poolWorker,
        poolPassword: poolPassword || undefined
      }
    }, {
      onSuccess: (rental) => {
        toast({ title: "Rental Deployed", description: "Rig will connect to your pool once the owner starts their miner" });
        setLocation(`/rentals/${rental.id}`);
      },
      onError: (err: Error) => {
        toast({ title: "Deployment Failed", description: err.message || "An error occurred", variant: "destructive" });
      }
    });
  };

  if (rigLoading) return <div className="p-8 text-center font-mono text-muted-foreground">LOADING_RIG_SPECS...</div>;
  if (!rig) return <div className="p-8 text-center font-mono text-destructive">RIG_NOT_FOUND</div>;

  const quote = createQuote.data;
  const isOffline = !rig.isOnline;

  return (
    <div className="container py-8 px-4 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Deploy Workload</h1>
        <p className="text-muted-foreground">Configure rental parameters for {rig.name}</p>
      </div>

      {isOffline && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-yellow-600 dark:text-yellow-400">
          <WifiOff className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-sm">This rig is currently offline</p>
            <p className="text-xs mt-1 opacity-80">
              Your balance will be charged immediately upon confirmation. Hashrate will only flow to your pool once the owner starts their miner and connects it to the proxy. If the rig never connects during your rental period, you can cancel at any time for a full refund.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> Duration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label>Rental Hours</Label>
                  <span className="font-mono text-lg font-bold">{hours}h</span>
                </div>
                <Slider
                  min={rig.minRentalHours}
                  max={rig.maxRentalHours}
                  step={1}
                  value={[hours]}
                  onValueChange={(v) => setHours(v[0])}
                  className="py-4"
                />
                <div className="flex justify-between text-xs text-muted-foreground font-mono">
                  <span>MIN: {rig.minRentalHours}h</span>
                  <span>MAX: {rig.maxRentalHours}h</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Your Pool Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Enter <span className="font-semibold text-foreground">your own pool</span> details — this is where the rented hashrate will be directed.
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
                        setPoolTestResult(null);
                      }
                    }}
                  >
                    <SelectTrigger className="font-mono text-sm bg-background">
                      <SelectValue placeholder="Pick from your saved pools…" />
                    </SelectTrigger>
                    <SelectContent>
                      {savedPools.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No saved pools yet. Add one to reuse it on every rental and rig.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="poolUrl">Stratum Pool URL</Label>
                <Input
                  id="poolUrl"
                  placeholder="stratum+tcp://pool.example.com:3333"
                  className="font-mono text-sm bg-background"
                  value={poolUrl}
                  onChange={(e) => setPoolUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="poolWorker">Worker Name</Label>
                <Input
                  id="poolWorker"
                  placeholder="walletAddress.workerName"
                  className="font-mono text-sm bg-background"
                  value={poolWorker}
                  onChange={(e) => setPoolWorker(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="poolPassword">Password (Optional)</Label>
                <Input
                  id="poolPassword"
                  placeholder="x"
                  className="font-mono text-sm bg-background"
                  value={poolPassword}
                  onChange={(e) => { setPoolPassword(e.target.value); setPoolTestResult(null); }}
                />
              </div>

              {/* Test connection */}
              <div className="flex items-center gap-3 flex-wrap pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs gap-2"
                  onClick={handleTestPool}
                  disabled={testPool.isPending}
                >
                  {testPool.isPending
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</>
                    : <><Activity className="w-3.5 h-3.5" /> Test Pool Connection</>
                  }
                </Button>
                <SaveAsPoolButton
                  poolUrl={poolUrl}
                  worker={poolWorker}
                  password={poolPassword}
                />
                {poolTestResult && (
                  <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border ${
                    poolTestResult.success
                      ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
                      : "text-red-500 bg-red-500/10 border-red-500/20"
                  }`}>
                    {poolTestResult.success
                      ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      : <XCircle className="w-3.5 h-3.5 shrink-0" />
                    }
                    <span>{poolTestResult.message}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card className={`border sticky top-20 ${isOffline ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-secondary/10 border-primary/20'}`}>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                {isOffline && <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                Deployment Quote
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-background/50 p-4 rounded-md border border-border/50 space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Rig</span>
                  <span className="font-medium flex items-center gap-1.5">
                    {rig.name}
                    {isOffline && (
                      <span className="text-[10px] font-mono bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded-full border border-yellow-500/30">
                        OFFLINE
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Algorithm</span>
                  <span className="font-medium">{rig.algorithmName}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Hashrate</span>
                  <span className="font-mono text-primary">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Rate</span>
                  <span className="font-mono">{formatMoney(rig.pricePerUnitPerHour)}/h</span>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Base Cost ({hours}h)</span>
                  <span className="font-mono">{quote ? formatMoney(quote.baseSubtotalUsd) : '---'}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Network Fee ({quote?.renterFeePct || 0}%)</span>
                  <span className="font-mono">{quote ? formatMoney(quote.renterFeeUsd) : '---'}</span>
                </div>
                <Separator className="my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-semibold">Total Cost</span>
                  <span className="text-2xl font-mono font-bold text-primary">
                    {quote ? formatMoney(quote.renterTotalUsd) : '---'}
                  </span>
                </div>
              </div>

              {me && quote && me.balanceUsd < quote.renterTotalUsd && (
                <div className="bg-destructive/10 text-destructive text-sm p-3 rounded flex items-start gap-2 border border-destructive/20">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Insufficient Balance</p>
                    <p className="mt-1">Wallet balance: {formatMoney(me.balanceUsd)}</p>
                  </div>
                </div>
              )}

              {isOffline && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400 text-center">
                  Balance is charged now — hashrate starts when the rig comes online
                </p>
              )}
            </CardContent>
            <CardFooter>
              <Button
                className="w-full font-mono text-sm h-12 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleDeploy}
                disabled={createRental.isPending || !quote || (me && quote && me.balanceUsd < quote.renterTotalUsd)}
              >
                {createRental.isPending ? "DEPLOYING..." : "CONFIRM_DEPLOYMENT"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
