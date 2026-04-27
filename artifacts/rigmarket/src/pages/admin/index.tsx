import { useState } from "react";
import {
  useGetAdminStats,
  useListAdminUsers,
  useGetCommissionConfig,
  useListAdminWithdrawals,
  useApproveWithdrawal,
  useRejectWithdrawal,
  useUpdateCommissionConfig,
  useAdminCreditWallet,
  useListAdminRigs,
  useApproveRig,
  useRejectRig,
  useListAdminRentals,
  useListAdminWalletTransactions,
  useListAlgorithms,
  useCreateAlgorithm,
  useUpdateAlgorithm,
  useDeleteAlgorithm,
  getGetAdminStatsQueryKey,
  getListAdminWithdrawalsQueryKey,
  getListAdminUsersQueryKey,
  getGetCommissionConfigQueryKey,
  getListAdminRigsQueryKey,
  getListAdminRentalsQueryKey,
  getListAdminWalletTransactionsQueryKey,
  getListAlgorithmsQueryKey,
} from "@workspace/api-client-react";
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
import { Shield, Check, X, Trash2 } from "lucide-react";
import { format } from "date-fns";

export default function AdminDashboard() {
  const { data: stats } = useGetAdminStats();
  const { data: users } = useListAdminUsers();
  const { data: config } = useGetCommissionConfig();
  const { data: withdrawals, isLoading: withdrawalsLoading } = useListAdminWithdrawals();
  const { data: pendingRigs, isLoading: pendingRigsLoading } = useListAdminRigs({ approvalStatus: "pending" });
  const { data: allRentals, isLoading: rentalsLoading } = useListAdminRentals();
  const { data: ledger, isLoading: ledgerLoading } = useListAdminWalletTransactions({ limit: 200 });
  const { data: algorithms, isLoading: algosLoading } = useListAlgorithms();

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const approveWithdrawal = useApproveWithdrawal();
  const rejectWithdrawal = useRejectWithdrawal();
  const updateConfig = useUpdateCommissionConfig();
  const creditWallet = useAdminCreditWallet();
  const approveRig = useApproveRig();
  const rejectRig = useRejectRig();
  const createAlgo = useCreateAlgorithm();
  const updateAlgo = useUpdateAlgorithm();
  const deleteAlgo = useDeleteAlgorithm();

  const [renterFee, setRenterFee] = useState("");
  const [ownerFee, setOwnerFee] = useState("");

  const [creditUserId, setCreditUserId] = useState<number | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditMemo, setCreditMemo] = useState("");

  const [newAlgoName, setNewAlgoName] = useState("");
  const [newAlgoSlug, setNewAlgoSlug] = useState("");
  const [newAlgoUnit, setNewAlgoUnit] = useState("");
  const [newAlgoPrice, setNewAlgoPrice] = useState("");

  const [editAlgoId, setEditAlgoId] = useState<number | null>(null);
  const [editAlgoPrice, setEditAlgoPrice] = useState("");

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
        queryClient.invalidateQueries({ queryKey: getListAdminWalletTransactionsQueryKey() });
        setCreditUserId(null);
        setCreditAmount("");
        setCreditMemo("");
      }
    });
  };

  const handleApproveRig = (id: number) => {
    const note = prompt("Optional approval note (press OK to skip):") || undefined;
    approveRig.mutate({ id, data: note ? { note } : {} }, {
      onSuccess: () => {
        toast({ title: "Rig Approved", description: "It is now visible in the marketplace." });
        queryClient.invalidateQueries({ queryKey: getListAdminRigsQueryKey({ approvalStatus: "pending" }) });
        queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
      },
      onError: (err: Error) => toast({ title: "Approve failed", description: err.message, variant: "destructive" })
    });
  };

  const handleRejectRig = (id: number) => {
    const note = prompt("Reason for rejection:");
    if (note === null) return;
    rejectRig.mutate({ id, data: note ? { note } : {} }, {
      onSuccess: () => {
        toast({ title: "Rig Rejected" });
        queryClient.invalidateQueries({ queryKey: getListAdminRigsQueryKey({ approvalStatus: "pending" }) });
      },
      onError: (err: Error) => toast({ title: "Reject failed", description: err.message, variant: "destructive" })
    });
  };

  const handleCreateAlgo = () => {
    if (!newAlgoName || !newAlgoSlug || !newAlgoUnit || !newAlgoPrice) return;
    createAlgo.mutate({
      data: {
        name: newAlgoName,
        slug: newAlgoSlug,
        unit: newAlgoUnit,
        basePricePerUnitPerHour: parseFloat(newAlgoPrice),
      }
    }, {
      onSuccess: () => {
        toast({ title: "Algorithm Added" });
        queryClient.invalidateQueries({ queryKey: getListAlgorithmsQueryKey() });
        setNewAlgoName(""); setNewAlgoSlug(""); setNewAlgoUnit(""); setNewAlgoPrice("");
      },
      onError: (err: Error) => toast({ title: "Add failed", description: err.message, variant: "destructive" })
    });
  };

  const handleUpdateAlgo = (id: number) => {
    if (!editAlgoPrice) return;
    updateAlgo.mutate({ id, data: { basePricePerUnitPerHour: parseFloat(editAlgoPrice) } }, {
      onSuccess: () => {
        toast({ title: "Algorithm Updated" });
        queryClient.invalidateQueries({ queryKey: getListAlgorithmsQueryKey() });
        setEditAlgoId(null);
        setEditAlgoPrice("");
      },
      onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" })
    });
  };

  const handleDeleteAlgo = (id: number, name: string) => {
    if (!confirm(`Delete algorithm "${name}"? This only works if no rigs use it.`)) return;
    deleteAlgo.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Algorithm Deleted" });
        queryClient.invalidateQueries({ queryKey: getListAlgorithmsQueryKey() });
      },
      onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" })
    });
  };

  const rentalStatusClass = (s: string) =>
    s === 'active' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' :
    s === 'completed' ? 'bg-green-500/10 text-green-500 border-green-500/20' :
    s === 'cancelled' ? 'bg-destructive/10 text-destructive border-destructive/20' :
    'bg-yellow-500/10 text-yellow-500 border-yellow-500/20';

  const txTypeClass = (t: string) =>
    t.includes('credit') || t === 'deposit' || t === 'rental_payout' || t === 'rental_refund'
      ? 'text-green-500' : 'text-destructive';

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

      <Tabs defaultValue="pending-rigs" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto flex-wrap">
          <TabsTrigger value="pending-rigs" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">
            Pending Rigs {pendingRigs && pendingRigs.length > 0 && <span className="ml-2 bg-yellow-500/20 text-yellow-500 px-1.5 rounded">{pendingRigs.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="withdrawals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Withdrawals</TabsTrigger>
          <TabsTrigger value="rentals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">All Rentals</TabsTrigger>
          <TabsTrigger value="ledger" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Ledger</TabsTrigger>
          <TabsTrigger value="users" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Users</TabsTrigger>
          <TabsTrigger value="algorithms" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Algorithms</TabsTrigger>
          <TabsTrigger value="config" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Config</TabsTrigger>
        </TabsList>

        <TabsContent value="pending-rigs" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">SUBMITTED</TableHead>
                    <TableHead className="font-mono text-xs">RIG / OWNER</TableHead>
                    <TableHead className="font-mono text-xs">ALGORITHM</TableHead>
                    <TableHead className="font-mono text-xs text-right">HASHRATE</TableHead>
                    <TableHead className="font-mono text-xs text-right">PRICE</TableHead>
                    <TableHead className="font-mono text-xs">REGION</TableHead>
                    <TableHead className="font-mono text-xs text-right">ACTION</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingRigsLoading ? (
                    <TableRow><TableCell colSpan={7} className="text-center py-8">LOADING...</TableCell></TableRow>
                  ) : !pendingRigs || pendingRigs.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No rigs awaiting approval.</TableCell></TableRow>
                  ) : pendingRigs.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(r.createdAt), "MMM d HH:mm")}</TableCell>
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.ownerDisplayName} ({r.ownerEmail})</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.algorithmName}</TableCell>
                      <TableCell className="text-right font-mono">{r.hashrate} {r.algorithmUnit}</TableCell>
                      <TableCell className="text-right font-mono">{formatMoney(r.pricePerUnitPerHour)}/hr</TableCell>
                      <TableCell className="font-mono text-xs">{r.region}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="icon" variant="outline" className="h-7 w-7 text-green-500 hover:text-green-600 hover:bg-green-500/10" onClick={() => handleApproveRig(r.id)} disabled={approveRig.isPending}><Check className="w-4 h-4" /></Button>
                          <Button size="icon" variant="outline" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleRejectRig(r.id)} disabled={rejectRig.isPending}><X className="w-4 h-4" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

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

        <TabsContent value="rentals" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">STARTED</TableHead>
                    <TableHead className="font-mono text-xs">RIG</TableHead>
                    <TableHead className="font-mono text-xs">RENTER</TableHead>
                    <TableHead className="font-mono text-xs">OWNER</TableHead>
                    <TableHead className="font-mono text-xs text-right">SPEC</TableHead>
                    <TableHead className="font-mono text-xs text-right">RENTER PAID</TableHead>
                    <TableHead className="font-mono text-xs text-right">OWNER GOT</TableHead>
                    <TableHead className="font-mono text-xs text-right">FEE</TableHead>
                    <TableHead className="font-mono text-xs text-right">STATUS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rentalsLoading ? (
                    <TableRow><TableCell colSpan={9} className="text-center py-8">LOADING...</TableCell></TableRow>
                  ) : !allRentals || allRentals.length === 0 ? (
                    <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No rentals on the platform yet.</TableCell></TableRow>
                  ) : allRentals.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(r.startedAt), "MMM d HH:mm")}</TableCell>
                      <TableCell className="text-sm font-medium">{r.rigName}</TableCell>
                      <TableCell className="text-xs">{r.renterEmail}</TableCell>
                      <TableCell className="text-xs">{r.ownerEmail}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.hashrate} {r.algorithmUnit} / {r.hours}h</TableCell>
                      <TableCell className="text-right font-mono">{formatMoney(r.renterTotalUsd)}</TableCell>
                      <TableCell className="text-right font-mono">{formatMoney(r.ownerEarningsUsd)}</TableCell>
                      <TableCell className="text-right font-mono text-primary">{formatMoney(r.platformFeeUsd)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase ${rentalStatusClass(r.status)}`}>{r.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ledger" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">TIME</TableHead>
                    <TableHead className="font-mono text-xs">USER</TableHead>
                    <TableHead className="font-mono text-xs">TYPE</TableHead>
                    <TableHead className="font-mono text-xs">MEMO</TableHead>
                    <TableHead className="font-mono text-xs text-right">AMOUNT</TableHead>
                    <TableHead className="font-mono text-xs text-right">BALANCE AFTER</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledgerLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8">LOADING...</TableCell></TableRow>
                  ) : !ledger || ledger.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No ledger entries.</TableCell></TableRow>
                  ) : ledger.map(t => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(t.createdAt), "MMM d HH:mm:ss")}</TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{t.userDisplayName}</div>
                        <div className="text-muted-foreground">{t.userEmail}</div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="font-mono text-[10px] uppercase">{t.type.replace('_', ' ')}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{t.memo}</TableCell>
                      <TableCell className={`text-right font-mono font-bold ${txTypeClass(t.type)}`}>
                        {t.amountUsd >= 0 ? '+' : ''}{formatMoney(t.amountUsd)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatMoney(t.balanceAfterUsd)}</TableCell>
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

        <TabsContent value="algorithms" className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2">
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="font-mono text-xs">NAME / SLUG</TableHead>
                        <TableHead className="font-mono text-xs">UNIT</TableHead>
                        <TableHead className="font-mono text-xs text-right">BASE PRICE</TableHead>
                        <TableHead className="font-mono text-xs text-right">RIGS</TableHead>
                        <TableHead className="font-mono text-xs text-right">ACTION</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {algosLoading ? (
                        <TableRow><TableCell colSpan={5} className="text-center py-8">LOADING...</TableCell></TableRow>
                      ) : !algorithms || algorithms.length === 0 ? (
                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No algorithms defined.</TableCell></TableRow>
                      ) : algorithms.map(a => (
                        <TableRow key={a.id}>
                          <TableCell>
                            <div className="font-medium">{a.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">{a.slug}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{a.unit}</TableCell>
                          <TableCell className="text-right font-mono">
                            {editAlgoId === a.id ? (
                              <div className="flex gap-1 justify-end items-center">
                                <Input type="number" step="0.0001" value={editAlgoPrice} onChange={e => setEditAlgoPrice(e.target.value)} className="h-7 w-24 font-mono text-xs bg-background" />
                                <Button size="sm" className="h-7 font-mono text-[10px]" onClick={() => handleUpdateAlgo(a.id)} disabled={updateAlgo.isPending}>SAVE</Button>
                                <Button size="sm" variant="ghost" className="h-7 font-mono text-[10px]" onClick={() => { setEditAlgoId(null); setEditAlgoPrice(""); }}>X</Button>
                              </div>
                            ) : (
                              <button className="hover:text-primary" onClick={() => { setEditAlgoId(a.id); setEditAlgoPrice(String(a.basePricePerUnitPerHour)); }}>
                                {formatMoney(a.basePricePerUnitPerHour)}/{a.unit}/hr
                              </button>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{a.rigCount}</TableCell>
                          <TableCell className="text-right">
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDeleteAlgo(a.id, a.name)} disabled={deleteAlgo.isPending || a.rigCount > 0} title={a.rigCount > 0 ? "Cannot delete: rigs in use" : "Delete"}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            <div>
              <Card className="bg-card/50 border-border/50">
                <CardHeader>
                  <CardTitle className="text-lg">Add Algorithm</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input placeholder="e.g. Kaspa" className="font-mono text-sm bg-background" value={newAlgoName} onChange={e => setNewAlgoName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Slug</Label>
                    <Input placeholder="e.g. khash" className="font-mono text-sm bg-background" value={newAlgoSlug} onChange={e => setNewAlgoSlug(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit</Label>
                    <Input placeholder="e.g. GH/s" className="font-mono text-sm bg-background" value={newAlgoUnit} onChange={e => setNewAlgoUnit(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Base Price (USD per unit per hour)</Label>
                    <Input type="number" step="0.0001" placeholder="e.g. 0.0250" className="font-mono text-sm bg-background" value={newAlgoPrice} onChange={e => setNewAlgoPrice(e.target.value)} />
                  </div>
                  <Button className="w-full font-mono text-xs" onClick={handleCreateAlgo} disabled={createAlgo.isPending || !newAlgoName || !newAlgoSlug || !newAlgoUnit || !newAlgoPrice}>
                    {createAlgo.isPending ? "ADDING..." : "ADD_ALGORITHM"}
                  </Button>
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
