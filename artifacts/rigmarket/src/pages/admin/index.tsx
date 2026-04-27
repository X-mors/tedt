import { useState } from "react";
import { useGetAdminStats, useListAdminUsers, useGetCommissionConfig, useListAdminWithdrawals, useApproveWithdrawal, useRejectWithdrawal, useUpdateCommissionConfig, useAdminCreditWallet, getGetAdminStatsQueryKey, getListAdminWithdrawalsQueryKey, getListAdminUsersQueryKey, getGetCommissionConfigQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Shield, Users, Server, Activity, DollarSign, Check, X } from "lucide-react";
import { format } from "date-fns";

export default function AdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetAdminStats();
  const { data: users, isLoading: usersLoading } = useListAdminUsers();
  const { data: config, isLoading: configLoading } = useGetCommissionConfig();
  const { data: withdrawals, isLoading: withdrawalsLoading } = useListAdminWithdrawals();
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const approveWithdrawal = useApproveWithdrawal();
  const rejectWithdrawal = useRejectWithdrawal();
  const updateConfig = useUpdateCommissionConfig();
  const creditWallet = useAdminCreditWallet();

  const [renterFee, setRenterFee] = useState("");
  const [ownerFee, setOwnerFee] = useState("");
  
  const [creditUserId, setCreditUserId] = useState<number | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditMemo, setCreditMemo] = useState("");

  const handleUpdateConfig = () => {
    updateConfig.mutate({
      data: {
        renterFeePct: renterFee ? parseFloat(renterFee) : undefined,
        ownerFeePct: ownerFee ? parseFloat(ownerFee) : undefined
      }
    }, {
      onSuccess: () => {
        toast({ title: "Config Updated", description: "Commission settings have been applied." });
        queryClient.invalidateQueries({ queryKey: getGetCommissionConfigQueryKey() });
        setRenterFee("");
        setOwnerFee("");
      }
    });
  };

  const handleApprove = (id: number) => {
    approveWithdrawal.mutate({ id, data: {} }, {
      onSuccess: () => {
        toast({ title: "Withdrawal Approved" });
        queryClient.invalidateQueries({ queryKey: getListAdminWithdrawalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
      }
    });
  };

  const handleReject = (id: number) => {
    const note = prompt("Reason for rejection:");
    if (note === null) return;
    rejectWithdrawal.mutate({ id, data: { adminNote: note } }, {
      onSuccess: () => {
        toast({ title: "Withdrawal Rejected" });
        queryClient.invalidateQueries({ queryKey: getListAdminWithdrawalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
      }
    });
  };

  const handleCredit = () => {
    if (!creditUserId || !creditAmount || !creditMemo) return;
    creditWallet.mutate({
      data: {
        userId: creditUserId,
        amountUsd: parseFloat(creditAmount),
        memo: creditMemo
      }
    }, {
      onSuccess: () => {
        toast({ title: "Wallet Credited", description: `Added ${creditAmount} USD` });
        queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        setCreditUserId(null);
        setCreditAmount("");
        setCreditMemo("");
      }
    });
  };

  return (
    <div className="container py-8 px-4 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <Shield className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin Override</h1>
          <p className="text-muted-foreground">Platform health, users, and financial oversight</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
             <CardTitle className="text-xs text-muted-foreground uppercase">Users</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-mono">{stats?.totalUsers || 0}</div></CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
             <CardTitle className="text-xs text-muted-foreground uppercase">Rigs (Avail/Total)</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-mono">{stats?.availableRigs || 0} / {stats?.totalRigs || 0}</div></CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
             <CardTitle className="text-xs text-muted-foreground uppercase">Active Rentals</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-mono">{stats?.activeRentals || 0}</div></CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
             <CardTitle className="text-xs text-muted-foreground uppercase">Platform Rev</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-mono text-primary">{formatMoney(stats?.platformRevenueUsd || 0)}</div></CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50 border-yellow-500/20">
          <CardHeader className="pb-2">
             <CardTitle className="text-xs text-yellow-500 uppercase">Pending Withdrawals</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-mono">{formatMoney(stats?.pendingWithdrawalsUsd || 0)}</div></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="withdrawals" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto">
          <TabsTrigger value="withdrawals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Withdrawal Queue</TabsTrigger>
          <TabsTrigger value="users" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Users & Ledgers</TabsTrigger>
          <TabsTrigger value="config" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Platform Config</TabsTrigger>
        </TabsList>
        
        <TabsContent value="withdrawals" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">TIME</TableHead>
                    <TableHead className="font-mono text-xs">USER</TableHead>
                    <TableHead className="font-mono text-xs">DESTINATION</TableHead>
                    <TableHead className="font-mono text-xs text-right">AMOUNT</TableHead>
                    <TableHead className="font-mono text-xs text-right">STATUS</TableHead>
                    <TableHead className="font-mono text-xs text-right">ACTION</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawalsLoading ? (
                     <TableRow><TableCell colSpan={6} className="text-center py-8">LOADING...</TableCell></TableRow>
                  ) : withdrawals?.length === 0 ? (
                     <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Queue is empty.</TableCell></TableRow>
                  ) : withdrawals?.map(wr => (
                    <TableRow key={wr.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(wr.createdAt), "MMM d HH:mm")}</TableCell>
                      <TableCell className="text-sm font-medium">{wr.userDisplayName}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <span className="text-primary mr-2">{wr.asset}</span>
                        {wr.destinationAddress}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">{formatMoney(wr.amountUsd)}</TableCell>
                      <TableCell className="text-right">
                         <Badge variant="outline" className={`font-mono text-[10px] uppercase
                          ${wr.status === 'approved' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 
                            wr.status === 'rejected' ? 'bg-destructive/10 text-destructive border-destructive/20' : 
                            'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'}`}>
                          {wr.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {wr.status === 'pending' && (
                          <div className="flex justify-end gap-2">
                            <Button size="icon" variant="outline" className="h-7 w-7 text-green-500 hover:text-green-600 hover:bg-green-500/10" onClick={() => handleApprove(wr.id)} disabled={approveWithdrawal.isPending}><Check className="w-4 h-4" /></Button>
                            <Button size="icon" variant="outline" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleReject(wr.id)} disabled={rejectWithdrawal.isPending}><X className="w-4 h-4" /></Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="md:col-span-3">
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="font-mono text-xs">ID / ROLE</TableHead>
                        <TableHead className="font-mono text-xs">USER</TableHead>
                        <TableHead className="font-mono text-xs text-right">RIGS/RENTALS</TableHead>
                        <TableHead className="font-mono text-xs text-right">BALANCE</TableHead>
                        <TableHead className="font-mono text-xs text-right">ACTION</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users?.map(u => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="font-mono text-xs text-muted-foreground">#{u.id}</div>
                            <Badge variant="outline" className="font-mono text-[10px] uppercase mt-1">{u.role}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{u.displayName}</div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{u.rigCount} / {u.rentalCount}</TableCell>
                          <TableCell className="text-right font-mono font-medium">{formatMoney(u.balanceUsd)}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={() => {
                              setCreditUserId(u.id);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}>CREDIT</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
            
            <div>
              <Card className={`bg-card/50 border-border/50 transition-all ${creditUserId ? 'border-primary ring-1 ring-primary/50' : ''}`}>
                <CardHeader>
                  <CardTitle className="text-lg">Manual Credit</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {creditUserId ? (
                    <>
                      <div className="text-sm bg-muted/50 p-2 rounded border font-mono">
                        Target User ID: {creditUserId}
                      </div>
                      <div className="space-y-2">
                        <Label>Amount (USD)</Label>
                        <Input type="number" placeholder="e.g. 50.00 (use negative for debit)" className="font-mono text-sm bg-background" value={creditAmount} onChange={e => setCreditAmount(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Memo</Label>
                        <Input placeholder="Reason for credit" className="font-mono text-sm bg-background" value={creditMemo} onChange={e => setCreditMemo(e.target.value)} />
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button variant="outline" className="flex-1 font-mono text-xs" onClick={() => setCreditUserId(null)}>CANCEL</Button>
                        <Button className="flex-1 font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90" onClick={handleCredit} disabled={creditWallet.isPending}>APPLY</Button>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-6">
                      Select 'CREDIT' on a user to apply manual ledger adjustments.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="config" className="pt-6">
          <Card className="bg-card/50 border-border/50 max-w-md">
            <CardHeader>
              <CardTitle className="text-lg">Commission Config</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="bg-muted/30 p-4 rounded border font-mono text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current Renter Fee:</span>
                  <span>{config?.renterFeePct}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current Owner Fee:</span>
                  <span>{config?.ownerFeePct}%</span>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>New Renter Fee (%)</Label>
                  <Input type="number" step="0.1" placeholder="e.g. 3.0" className="font-mono text-sm bg-background" value={renterFee} onChange={e => setRenterFee(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Added to base cost.</p>
                </div>
                <div className="space-y-2">
                  <Label>New Owner Fee (%)</Label>
                  <Input type="number" step="0.1" placeholder="e.g. 5.0" className="font-mono text-sm bg-background" value={ownerFee} onChange={e => setOwnerFee(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Withheld from rig owner earnings.</p>
                </div>
                <Button className="w-full font-mono text-sm mt-2" onClick={handleUpdateConfig} disabled={updateConfig.isPending || (!renterFee && !ownerFee)}>
                  {updateConfig.isPending ? "APPLYING..." : "UPDATE_CONFIG"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
