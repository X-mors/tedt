import { useEffect } from "react";
import { useParams } from "wouter";
import { useGetRental, useGetRentalStats, useGetRentalLive, getGetRentalLiveQueryKey, getGetRentalStatsQueryKey, useCancelRental, useCreateRentalReview, getGetRentalQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatSeconds } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, CheckCircle2, Wifi, WifiOff, BarChart2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { Star, ShieldAlert } from "lucide-react";

function StatusDot({ connected, label, sublabel }: { connected: boolean; label: string; sublabel?: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
      connected
        ? 'text-green-500 border-green-500/30 bg-green-500/10'
        : 'text-muted-foreground border-border/40 bg-muted/20'
    }`}>
      <div className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/50'}`} />
      <div>
        <p className="text-xs font-mono font-semibold">{label}</p>
        {sublabel && <p className="text-[10px] opacity-70">{sublabel}</p>}
      </div>
    </div>
  );
}

export default function RentalCockpit() {
  const { id } = useParams<{ id: string }>();
  const rentalId = parseInt(id || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rental, isLoading: rentalLoading } = useGetRental(rentalId);

  const { data: live } = useGetRentalLive(rentalId, {
    query: {
      enabled: !!rentalId && rental?.status === 'active',
      refetchInterval: 5000,
      queryKey: getGetRentalLiveQueryKey(rentalId),
    },
  });

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
    toast({ title: "تم النسخ", description: `${label} تم نسخه.` });
  };

  const handleCancel = () => {
    if (confirm("هل أنت متأكد من إلغاء هذا الإيجار؟ سيتم استرداد الرصيد المتبقي.")) {
      cancelRental.mutate({ id: rentalId }, {
        onSuccess: () => {
          toast({ title: "تم إلغاء الإيجار" });
          queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(rentalId) });
        },
        onError: (err) => {
          toast({ title: "فشل الإلغاء", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const handleReviewSubmit = () => {
    if (!reviewBody.trim()) {
       toast({ title: "خطأ في التحقق", description: "الرجاء كتابة تقييمك.", variant: "destructive" });
       return;
    }
    createReview.mutate({ id: rentalId, data: { rating: reviewRating, body: reviewBody } }, {
      onSuccess: () => {
        toast({ title: "تم إرسال التقييم" });
        setReviewOpen(false);
      },
      onError: (err) => {
        toast({ title: "فشل الإرسال", description: err.message, variant: "destructive" });
      }
    });
  };

  if (rentalLoading) return <div className="p-8 text-center font-mono text-muted-foreground">جارٍ تحميل البيانات...</div>;
  if (!rental) return <div className="p-8 text-center font-mono text-destructive">RENTAL_NOT_FOUND</div>;

  const totalSeconds = rental.hours * 3600;
  const elapsedPercent = live ? ((totalSeconds - live.secondsRemaining) / totalSeconds) * 100 : 0;

  const minerConnected = live?.minerConnected ?? false;
  const poolConnected = live?.upstreamConnected ?? false;

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">إيجار #{rental.id}</h1>
            <Badge variant="outline" className={`font-mono text-xs uppercase
              ${rental.status === 'active' ? 'bg-primary/20 text-primary border-primary/30' :
                rental.status === 'completed' ? 'bg-green-500/20 text-green-500 border-green-500/30' :
                rental.status === 'pending' ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30' :
                'bg-destructive/20 text-destructive border-destructive/30'}`}>
              {rental.status === 'active' ? 'نشط' : rental.status === 'completed' ? 'مكتمل' : rental.status === 'pending' ? 'قيد الانتظار' : 'ملغي'}
            </Badge>
          </div>
          <p className="text-muted-foreground flex items-center gap-2">
            <Server className="w-4 h-4" /> {rental.rigName} · {rental.algorithmName}
          </p>
        </div>

        <div className="flex gap-2">
          {rental.status === 'active' && (
            <Button variant="destructive" className="font-mono text-xs" onClick={handleCancel} disabled={cancelRental.isPending}>
              إلغاء الإيجار
            </Button>
          )}
          {rental.status === 'completed' && (
            <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
              <DialogTrigger asChild>
                <Button className="font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90">
                  تقييم الريج
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>قيّم تجربتك</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>التقييم</Label>
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
                    <Label>التعليق</Label>
                    <Textarea
                      placeholder="كيف كان أداء الريج؟"
                      value={reviewBody}
                      onChange={(e) => setReviewBody(e.target.value)}
                      className="bg-background"
                    />
                  </div>
                  <Button onClick={handleReviewSubmit} disabled={createReview.isPending} className="w-full">
                    {createReview.isPending ? "جارٍ الإرسال..." : "إرسال التقييم"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Telemetry */}
        <div className="md:col-span-2 space-y-6">

          {/* Connection status bar — always visible when active */}
          {rental.status === 'active' && (
            <div className="grid grid-cols-2 gap-3">
              <StatusDot
                connected={minerConnected}
                label="جهاز المالك"
                sublabel={minerConnected ? "متصل بالبروكسي" : "في انتظار اتصال الجهاز"}
              />
              <StatusDot
                connected={poolConnected}
                label="بولك"
                sublabel={poolConnected ? "يستقبل الهاش الآن" : minerConnected ? "جارٍ الاتصال بالبول..." : "ينتظر الجهاز أولاً"}
              />
            </div>
          )}

          {/* Live Telemetry card */}
          <Card className="bg-card/50 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> بيانات الأداء الحي
              </CardTitle>
            </CardHeader>
            <CardContent>
              {rental.status === 'active' && live && !live.minerConnected ? (
                <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10">
                  <WifiOff className="w-8 h-8 text-muted-foreground mb-4" />
                  <p className="font-mono text-sm text-muted-foreground uppercase">في انتظار اتصال جهاز المالك</p>
                  <p className="text-xs text-muted-foreground mt-2">سيبدأ الهاش بالتدفق إلى بولك فور اتصال الريج. يُحدَّث كل 5 ثوانٍ.</p>
                </div>
              ) : rental.status === 'active' && live && live.minerConnected && !live.upstreamConnected ? (
                <div className="text-center py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-lg bg-muted/10">
                  <Wifi className="w-8 h-8 text-yellow-500 animate-pulse mb-4" />
                  <p className="font-mono text-sm text-yellow-500 uppercase">الجهاز متصل — جارٍ تأسيس الاتصال ببولك</p>
                  <p className="text-xs text-muted-foreground mt-2">سيبدأ الهاش في الوصول إلى بولك خلال لحظات.</p>
                </div>
              ) : rental.status === 'active' && live ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">الهاشريت الحالي</span>
                      <span className="font-mono text-lg font-bold text-primary">{formatHashrate(live.currentHashrate, rental.algorithmUnit)}</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">متوسط الهاشريت</span>
                      <span className="font-mono text-lg font-bold">{stats ? formatHashrate(stats.averageHashrate, rental.algorithmUnit) : '—'}</span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">نسبة التسليم</span>
                      <span className={`font-mono text-lg font-bold ${live.deliveryRatio >= 0.95 ? 'text-green-500' : live.deliveryRatio >= 0.8 ? 'text-yellow-500' : 'text-destructive'}`}>
                        {(live.deliveryRatio * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="bg-background/50 p-4 rounded-md border border-border/50 flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">Shares (مقبول/مرفوض)</span>
                      <span className="font-mono text-lg font-bold"><span className="text-green-500">{live.sharesAccepted}</span> / <span className="text-destructive">{live.sharesRejected}</span></span>
                    </div>
                  </div>

                  {/* Chart */}
                  {stats && stats.samples.length > 1 ? (
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
                  ) : (
                    <div className="flex items-center justify-center gap-2 h-16 bg-background/30 rounded-md border border-dashed border-border/30 text-muted-foreground">
                      <BarChart2 className="w-4 h-4" />
                      <span className="text-xs font-mono">ستظهر بيانات الهاشريت هنا بعد بدء التعدين</span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-mono text-muted-foreground">
                      <span>الوقت المنقضي</span>
                      <span>المتبقي: {formatSeconds(live?.secondsRemaining ?? 0)}</span>
                    </div>
                    <Progress value={Math.min(100, Math.max(0, elapsedPercent))} className="h-2" />
                  </div>
                </div>
              ) : rental.status === 'completed' || rental.status === 'cancelled' ? (
                <div className="text-center py-10">
                  {rental.status === 'completed' ? <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" /> : <ShieldAlert className="w-10 h-10 text-muted-foreground mx-auto mb-3" />}
                  <h3 className="font-medium text-lg">{rental.status === 'completed' ? 'اكتمل الإيجار' : 'تم إلغاء الإيجار'}</h3>
                  {rental.deliveredHashrateAvg !== null && (
                    <p className="text-sm text-muted-foreground mt-2">
                      متوسط الهاشريت المُسلَّم: <span className="font-mono text-foreground">{formatHashrate(rental.deliveredHashrateAvg, rental.algorithmUnit)}</span>
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-center py-10 text-muted-foreground font-mono text-sm">
                  جارٍ تهيئة الاتصال...
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Pool config + Rental info */}
        <div className="space-y-6">

          {/* Renter's pool config */}
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">بولك المستهدف</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">عنوان البول</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs break-all bg-muted/30 px-2 py-1.5 rounded flex-1">{rental.poolUrl}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">العامل (Worker)</span>
                <span className="font-mono text-xs bg-muted/30 px-2 py-1.5 rounded">{rental.poolWorker}</span>
              </div>
              {rental.status === 'active' && (
                <div className={`flex items-center gap-2 mt-2 text-xs px-2 py-1.5 rounded-md border ${
                  poolConnected
                    ? 'text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30'
                    : 'text-muted-foreground bg-muted/20 border-border/40'
                }`}>
                  {poolConnected
                    ? <><Wifi className="w-3 h-3" /> البول يستقبل الهاش</>
                    : <><WifiOff className="w-3 h-3" /> في انتظار الاتصال</>
                  }
                </div>
              )}
            </CardContent>
          </Card>

          {/* Rental summary */}
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">ملخص الإيجار</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">الريج</span>
                <span className="font-medium">{rental.rigName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">المدة</span>
                <span className="font-mono">{rental.hours}h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">الخوارزمية</span>
                <span>{rental.algorithmName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">التكلفة الإجمالية</span>
                <span className="font-mono font-semibold text-primary">${rental.renterTotalUsd.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
