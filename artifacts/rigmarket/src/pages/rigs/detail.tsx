import { useParams, Link } from "wouter";
import { useGetRig, useListRigReviews, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Server, Activity, MapPin, Clock, Star, ShieldCheck } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { format } from "date-fns";

export default function RigDetail() {
  const { id } = useParams<{ id: string }>();
  const rigId = parseInt(id || "0");
  
  // orval defaults `enabled: !!id`, so we can omit it.
  const { data: rig, isLoading } = useGetRig(rigId);
  const { data: reviews } = useListRigReviews(rigId);
  const { data: me } = useGetMe();

  if (isLoading) {
    return <div className="p-8 text-center font-mono text-muted-foreground">LOADING_RIG_DATA...</div>;
  }

  if (!rig) return <div className="p-8 text-center font-mono text-destructive">RIG_NOT_FOUND</div>;

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">{rig.name}</h1>
            <Badge variant={rig.status === 'available' ? 'default' : rig.status === 'rented' ? 'secondary' : 'destructive'} 
                   className={`font-mono text-xs uppercase ${rig.status === 'available' ? 'bg-primary/20 text-primary border-primary/30' : ''}`}>
              {rig.status}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><Server className="w-4 h-4" /> {rig.ownerDisplayName}</span>
            <span className="flex items-center gap-1"><MapPin className="w-4 h-4" /> {rig.region}</span>
            <span className="flex items-center gap-1"><Activity className="w-4 h-4" /> {rig.totalRentals} rentals</span>
            {rig.averageRating && <span className="flex items-center gap-1 text-yellow-500 font-mono"><Star className="w-4 h-4 fill-current" /> {rig.averageRating.toFixed(1)}</span>}
          </div>
        </div>
        
        {rig.status === 'available' && rig.ownerId !== me?.id && (
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

              {rig.status === 'available' ? (
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
