import { useListAlgorithms } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Activity } from "lucide-react";

export default function Algorithms() {
  const { data: algorithms, isLoading } = useListAlgorithms();

  return (
    <div className="container py-8 px-4 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Algorithm Catalog</h1>
        <p className="text-muted-foreground">Global network statistics and base pricing by algorithm</p>
      </div>

      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="font-mono text-xs">ALGORITHM</TableHead>
                <TableHead className="font-mono text-xs text-right">ACTIVE_RIGS</TableHead>
                <TableHead className="font-mono text-xs text-right">TOTAL_HASHRATE</TableHead>
                <TableHead className="font-mono text-xs text-right">BASE_PRICE/HR</TableHead>
                <TableHead className="font-mono text-xs text-right">AVG_MARKET_PRICE</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-muted-foreground font-mono text-sm">
                    LOADING_DATA...
                  </TableCell>
                </TableRow>
              ) : algorithms?.map(algo => (
                <TableRow key={algo.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-primary" />
                      {algo.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{algo.rigCount}</TableCell>
                  <TableCell className="text-right font-mono text-primary">{formatHashrate(algo.totalHashrate, algo.unit)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(algo.basePricePerUnitPerHour)} / {algo.unit}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{formatMoney(algo.averagePricePerUnitPerHour)} / {algo.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
