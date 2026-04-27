import { useListMyRentals } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { Link } from "wouter";
import { Activity, Server } from "lucide-react";

export default function MyRentals() {
  const { data: rentals, isLoading } = useListMyRentals();

  return (
    <div className="container py-8 px-4 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Rentals</h1>
        <p className="text-muted-foreground">Active and historical workloads</p>
      </div>

      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="font-mono text-xs">ID</TableHead>
                <TableHead className="font-mono text-xs">STATUS</TableHead>
                <TableHead className="font-mono text-xs">RIG</TableHead>
                <TableHead className="font-mono text-xs">ALGORITHM</TableHead>
                <TableHead className="font-mono text-xs text-right">HASHRATE</TableHead>
                <TableHead className="font-mono text-xs text-right">DURATION</TableHead>
                <TableHead className="font-mono text-xs text-right">COST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground font-mono text-sm">
                    LOADING_RENTALS...
                  </TableCell>
                </TableRow>
              ) : rentals?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    No rentals found. <Link href="/marketplace" className="text-primary hover:underline">Browse the marketplace</Link> to deploy a workload.
                  </TableCell>
                </TableRow>
              ) : rentals?.map(rental => (
                <TableRow key={rental.id} className="cursor-pointer group hover:bg-muted/20" onClick={() => window.location.href = `/rentals/${rental.id}`}>
                  <TableCell className="font-mono text-xs text-muted-foreground">#{rental.id}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`font-mono text-[10px] uppercase
                      ${rental.status === 'active' ? 'bg-primary/20 text-primary border-primary/30' : 
                        rental.status === 'completed' ? 'bg-green-500/20 text-green-500 border-green-500/30' : 
                        rental.status === 'pending' ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30' : 
                        'bg-destructive/20 text-destructive border-destructive/30'}`}>
                      {rental.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium group-hover:text-primary transition-colors">
                    <div className="flex items-center gap-2">
                      <Server className="w-3 h-3 text-muted-foreground" />
                      {rental.rigName}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{rental.algorithmName}</TableCell>
                  <TableCell className="text-right font-mono text-primary">{formatHashrate(rental.hashrate, rental.algorithmUnit)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{rental.hours}h</TableCell>
                  <TableCell className="text-right font-mono font-medium">{formatMoney(rental.renterTotalUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
