import { useListMyRigs, useListLessorRentals, useDeleteMyRig, getListMyRigsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHashrate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Server, Activity, Plus, Edit2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function LessorDashboard() {
  const { data: rigs, isLoading: rigsLoading } = useListMyRigs();
  const { data: rentals, isLoading: rentalsLoading } = useListLessorRentals();
  const deleteRig = useDeleteMyRig();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleDeleteRig = (id: number, name: string) => {
    if (confirm(`Are you sure you want to delete rig "${name}"? This action cannot be undone.`)) {
      deleteRig.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Rig Deleted", description: `Rig ${name} has been removed.` });
          queryClient.invalidateQueries({ queryKey: getListMyRigsQueryKey() });
        },
        onError: (err) => {
          toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  return (
    <div className="container py-8 px-4 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Owner Inventory</h1>
          <p className="text-muted-foreground">Manage your hardware and monitor incoming workloads</p>
        </div>
        <Link href="/lessor/rigs/new">
          <Button className="font-mono text-sm bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2">
            <Plus className="w-4 h-4" /> ADD_RIG
          </Button>
        </Link>
      </div>

      <Tabs defaultValue="rigs" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto">
          <TabsTrigger value="rigs" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">My Hardware</TabsTrigger>
          <TabsTrigger value="rentals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Active & Past Leases</TabsTrigger>
        </TabsList>
        
        <TabsContent value="rigs" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">NAME</TableHead>
                    <TableHead className="font-mono text-xs">STATUS</TableHead>
                    <TableHead className="font-mono text-xs">ALGORITHM</TableHead>
                    <TableHead className="font-mono text-xs text-right">HASHRATE</TableHead>
                    <TableHead className="font-mono text-xs text-right">RATE/HR</TableHead>
                    <TableHead className="font-mono text-xs text-right">ACTIONS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rigsLoading ? (
                     <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_INVENTORY...</TableCell>
                    </TableRow>
                  ) : rigs?.length === 0 ? (
                     <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                        No rigs found. Add a rig to start earning.
                      </TableCell>
                    </TableRow>
                  ) : rigs?.map(rig => (
                    <TableRow key={rig.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Server className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="flex flex-col">
                            <Link href={`/rigs/${rig.id}`} className="hover:text-primary transition-colors">{rig.name}</Link>
                            {rig.stratumName ? (
                              <span className="text-[10px] font-mono text-muted-foreground">worker: {rig.stratumName}</span>
                            ) : (
                              <span className="text-[10px] font-mono text-muted-foreground/50">no stratum name</span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {rig.approvalStatus === 'pending' && (
                            <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-orange-500/10 text-orange-500 border-orange-500/30">
                              PENDING REVIEW
                            </Badge>
                          )}
                          {rig.approvalStatus === 'rejected' && (
                            <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-destructive/10 text-destructive border-destructive/30">
                              REJECTED
                            </Badge>
                          )}
                          <Badge variant="outline" className={`font-mono text-[10px] uppercase w-fit
                            ${rig.status === 'available' ? 'bg-primary/20 text-primary border-primary/30' : 
                              rig.status === 'rented' ? 'bg-secondary/50 text-secondary-foreground border-secondary' : 
                              'bg-destructive/20 text-destructive border-destructive/30'}`}>
                            {rig.status}
                          </Badge>
                          {rig.isOnline && rig.status !== 'rented' && rig.hasFallbackPool && (
                            <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                              MINING FALLBACK
                            </Badge>
                          )}
                          {rig.isOnline && rig.status !== 'rented' && !rig.hasFallbackPool && (
                            <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-green-500/10 text-green-500 border-green-500/30">
                              ONLINE · IDLE
                            </Badge>
                          )}
                          {rig.isOnline && rig.status === 'rented' && (
                            <Badge variant="outline" className="font-mono text-[10px] uppercase w-fit bg-green-500/10 text-green-500 border-green-500/30">
                              CONNECTED
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{rig.algorithmName}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatHashrate(rig.hashrate, rig.algorithmUnit)}</TableCell>
                      <TableCell className="text-right font-mono">{formatMoney(rig.pricePerUnitPerHour)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Link href={`/lessor/rigs/${rig.id}/edit`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8"><Edit2 className="w-4 h-4" /></Button>
                          </Link>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDeleteRig(rig.id, rig.name)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rentals" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">ID</TableHead>
                    <TableHead className="font-mono text-xs">STATUS</TableHead>
                    <TableHead className="font-mono text-xs">RIG</TableHead>
                    <TableHead className="font-mono text-xs">RENTER</TableHead>
                    <TableHead className="font-mono text-xs text-right">DURATION</TableHead>
                    <TableHead className="font-mono text-xs text-right">EARNINGS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rentalsLoading ? (
                     <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_LEASES...</TableCell>
                    </TableRow>
                  ) : rentals?.length === 0 ? (
                     <TableRow>
                      <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                        No lease history found.
                      </TableCell>
                    </TableRow>
                  ) : rentals?.map(rental => (
                    <TableRow key={rental.id}>
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
                      <TableCell className="font-medium text-sm">{rental.rigName}</TableCell>
                      <TableCell className="text-sm">{rental.renterDisplayName}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{rental.hours}h</TableCell>
                      <TableCell className="text-right font-mono font-medium text-green-500">+{formatMoney(rental.ownerEarningsUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
