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
import { Server, Activity, Clock, ShieldAlert, WifiOff, AlertTriangle } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export default function NewRental() {
  const { rigId: rigIdParam } = useParams<{ rigId: string }>();
  const rigId = parseInt(rigIdParam || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: rig, isLoading: rigLoading } = useGetRig(rigId);
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
    return undefined;
  }, [rigId, hours, rig?.minRentalHours]);

  const handleDeploy = () => {
    if (!poolUrl || !poolWorker) {
      toast({ title: "خطأ في التحقق", description: "عنوان البول واسم العامل مطلوبان", variant: "destructive" });
      return;
    }
    
    if (me && createQuote.data && me.balanceUsd < createQuote.data.renterTotalUsd) {
      toast({ title: "رصيد غير كافٍ", description: "الرجاء إيداع مزيد من الأموال في محفظتك", variant: "destructive" });
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
        toast({ title: "تم نشر الإيجار", description: "سيتصل الريج ببولك عند تشغيله" });
        setLocation(`/rentals/${rental.id}`);
      },
      onError: (err: Error) => {
        toast({ title: "فشل النشر", description: err.message || "حدث خطأ غير متوقع", variant: "destructive" });
      }
    });
  };

  if (rigLoading) return <div className="p-8 text-center font-mono text-muted-foreground">جارٍ تحميل البيانات...</div>;
  if (!rig) return <div className="p-8 text-center font-mono text-destructive">RIG_NOT_FOUND</div>;

  const quote = createQuote.data;
  const isOffline = !rig.isOnline;

  return (
    <div className="container py-8 px-4 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">تأكيد الإيجار</h1>
        <p className="text-muted-foreground">إعداد معاملات الإيجار لـ {rig.name}</p>
      </div>

      {isOffline && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-yellow-600 dark:text-yellow-400">
          <WifiOff className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-sm">الريج حاليًا غير متصل بالإنترنت</p>
            <p className="text-xs mt-1 opacity-80">
              سيُخصم الرصيد فور تأكيد الإيجار. لن يبدأ الهاش في التدفق إلى بولك إلا بعد أن يقوم المالك بتشغيل الجهاز وتوصيله بالبروكسي. إذا لم يتصل الريج طوال مدة الإيجار، ستحصل على استرداد كامل عند الإلغاء.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> المدة
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label>ساعات الإيجار</Label>
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
                  <span>الحد الأدنى: {rig.minRentalHours}h</span>
                  <span>الحد الأقصى: {rig.maxRentalHours}h</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> بيانات البول الخاص بك
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                أدخل بيانات <span className="font-semibold text-foreground">بولك الخاص</span> — هذا هو العنوان الذي سيُوجَّه إليه هاشريت الريج المستأجر.
              </p>
              <div className="space-y-2">
                <Label htmlFor="poolUrl">عنوان Stratum Pool</Label>
                <Input 
                  id="poolUrl" 
                  placeholder="stratum+tcp://pool.example.com:3333" 
                  className="font-mono text-sm bg-background"
                  value={poolUrl}
                  onChange={(e) => setPoolUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="poolWorker">اسم العامل (Worker)</Label>
                <Input 
                  id="poolWorker" 
                  placeholder="عنوان_محفظتك.اسم_العامل" 
                  className="font-mono text-sm bg-background"
                  value={poolWorker}
                  onChange={(e) => setPoolWorker(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="poolPassword">كلمة المرور (اختياري)</Label>
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
          <Card className={`border sticky top-20 ${isOffline ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-secondary/10 border-primary/20'}`}>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                {isOffline && <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                ملخص الإيجار
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-background/50 p-4 rounded-md border border-border/50 space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">الريج</span>
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
                  <span className="text-muted-foreground">الخوارزمية</span>
                  <span className="font-medium">{rig.algorithmName}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">الهاشريت</span>
                  <span className="font-mono text-primary">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">السعر</span>
                  <span className="font-mono">{formatMoney(rig.pricePerUnitPerHour)}/h</span>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">التكلفة الأساسية ({hours}h)</span>
                  <span className="font-mono">{quote ? formatMoney(quote.baseSubtotalUsd) : '---'}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">رسوم الشبكة ({quote?.renterFeePct || 0}%)</span>
                  <span className="font-mono">{quote ? formatMoney(quote.renterFeeUsd) : '---'}</span>
                </div>
                <Separator className="my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-semibold">الإجمالي</span>
                  <span className="text-2xl font-mono font-bold text-primary">
                    {quote ? formatMoney(quote.renterTotalUsd) : '---'}
                  </span>
                </div>
              </div>

              {me && quote && me.balanceUsd < quote.renterTotalUsd && (
                <div className="bg-destructive/10 text-destructive text-sm p-3 rounded flex items-start gap-2 border border-destructive/20">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">رصيد غير كافٍ</p>
                    <p className="mt-1">الرصيد الحالي: {formatMoney(me.balanceUsd)}</p>
                  </div>
                </div>
              )}

              {isOffline && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400 text-center">
                  سيُخصم الرصيد الآن — الهاش يبدأ عند اتصال الريج
                </p>
              )}
            </CardContent>
            <CardFooter>
              <Button 
                className="w-full font-mono text-sm h-12 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleDeploy}
                disabled={createRental.isPending || !quote || (me && quote && me.balanceUsd < quote.renterTotalUsd)}
              >
                {createRental.isPending ? "جارٍ النشر..." : "تأكيد الإيجار"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
