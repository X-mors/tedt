import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useGetRig, useCreateRentalQuote, useCreateRental, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { Server, Activity, DollarSign, Clock, ShieldAlert } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export default function NewRental() {
  const { id } = useParams<{ rigId: string }>();
  const rigId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: rig, isLoading: rigLoading } = useGetRig(rigId, { query: { enabled: !!rigId } });
  const { data: me } = useGetMe();
  
  const [hours, setHours] = useState(1);
  const [poolUrl, setPoolUrl] = useState("");
  const [poolWorker, setPoolWorker] = useState("");
  const [poolPassword, setPoolPassword] = useState("");

  const createQuote = useCreateRentalQuote();
  const createRental = useCreateRental();

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
  }, [rigId, hours, rig?.minRentalHours]);

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
        toast({ title: "Rental Deployed", description: "Rig is connecting to your pool" });
        setLocation(`/rentals/${rental.id}`);
      },
      onError: (err: any) => {
        toast({ title: "Deployment Failed", description: err.message || "An error occurred", variant: "destructive" });
      }
    });
  };

  if (rigLoading) return <div className="p-8 text-center font-mono text-muted-foreground">LOADING_RIG_SPECS...</div>;
  if (!rig) return <div className="p-8 text-center font-mono text-destructive">RIG_NOT_FOUND</div>;

  const quote = createQuote.data;

  return (
    <div className="container py-8 px-4 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Deploy Workload</h1>
        <p className="text-muted-foreground">Configure rental parameters for {rig.name}</p>
      </div>

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
                <Activity className="w-4 h-4 text-primary" /> Pool Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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
                  onChange={(e) => setPoolPassword(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card className="bg-secondary/10 border-primary/20 sticky top-20">
            <CardHeader>
              <CardTitle className="text-lg">Deployment Quote</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-background/50 p-4 rounded-md border border-border/50 space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Rig</span>
                  <span className="font-medium">{rig.name}</span>
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
