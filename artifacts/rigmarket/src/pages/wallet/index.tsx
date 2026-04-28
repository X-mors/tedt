import { useState } from "react";
import { useGetMyWallet, useCreateDeposit, useCreateWithdrawal, useListMyWithdrawals, getGetMyWalletQueryKey, getListMyWithdrawalsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Wallet as WalletIcon, ArrowDownToLine, ArrowUpFromLine, Activity, History, Copy } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export default function Wallet() {
  const { data: wallet, isLoading: walletLoading } = useGetMyWallet();
  const { data: withdrawals, isLoading: withdrawalsLoading } = useListMyWithdrawals();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createDeposit = useCreateDeposit();
  const createWithdrawal = useCreateWithdrawal();

  type DepositAsset = "BTC" | "USDT";
  type DepositInstructions = {
    asset: DepositAsset;
    depositAddress: string;
    memo: string;
    amountUsd: number;
    note: string;
  };

  const [depositAsset, setDepositAsset] = useState<DepositAsset>("USDT");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositInstructions, setDepositInstructions] =
    useState<DepositInstructions | null>(null);

  const [withdrawAsset, setWithdrawAsset] = useState<DepositAsset>("USDT");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard", description: `${label} copied.` });
  };

  const handleDepositRequest = () => {
    const amt = parseFloat(depositAmount);
    if (!amt || amt <= 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    createDeposit.mutate({ data: { asset: depositAsset, amountUsd: amt } }, {
      onSuccess: (data) => {
        setDepositInstructions(data as DepositInstructions);
      },
      onError: (err) => {
        toast({ title: "Failed to generate address", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleWithdrawRequest = () => {
    const amt = parseFloat(withdrawAmount);
    if (!amt || amt <= 0 || !withdrawAddress) {
      toast({ title: "Invalid input", variant: "destructive" });
      return;
    }
    createWithdrawal.mutate({ data: { asset: withdrawAsset, amountUsd: amt, destinationAddress: withdrawAddress } }, {
      onSuccess: () => {
        toast({ title: "Withdrawal Requested", description: "Your request is pending admin approval." });
        setWithdrawOpen(false);
        setWithdrawAmount("");
        setWithdrawAddress("");
        queryClient.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListMyWithdrawalsQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Request Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <div className="container py-8 px-4 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Wallet</h1>
        <p className="text-muted-foreground">Manage your funds and transaction history</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card/50 border-border/50 md:col-span-2">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <WalletIcon className="w-5 h-5 text-primary" /> Current Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-primary mb-6">
              {walletLoading ? "---" : formatMoney(wallet?.balanceUsd || 0)}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Total Deposited</span>
                <div className="font-mono">{walletLoading ? "---" : formatMoney(wallet?.totalDepositedUsd || 0)}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Total Spent</span>
                <div className="font-mono text-destructive">{walletLoading ? "---" : formatMoney(wallet?.totalSpentUsd || 0)}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Total Earned</span>
                <div className="font-mono text-green-500">{walletLoading ? "---" : formatMoney(wallet?.totalEarnedUsd || 0)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-secondary/10 border-primary/20 flex flex-col justify-center">
          <CardContent className="space-y-4 pt-6">
            <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full font-mono flex items-center justify-center gap-2 h-12">
                  <ArrowUpFromLine className="w-4 h-4" /> WITHDRAW_FUNDS
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Request Withdrawal</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Asset</Label>
                    <Select value={withdrawAsset} onValueChange={(v) => setWithdrawAsset(v as DepositAsset)}>
                      <SelectTrigger className="font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USDT">USDT (ERC20)</SelectItem>
                        <SelectItem value="BTC">Bitcoin (BTC)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Amount (USD Value)</Label>
                    <Input 
                      type="number" 
                      className="font-mono" 
                      placeholder="e.g. 100.00"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground font-mono">Available: {formatMoney(wallet?.balanceUsd || 0)}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Destination Address</Label>
                    <Input 
                      className="font-mono text-xs" 
                      placeholder="Enter destination address..."
                      value={withdrawAddress}
                      onChange={(e) => setWithdrawAddress(e.target.value)}
                    />
                  </div>
                  <Button onClick={handleWithdrawRequest} disabled={createWithdrawal.isPending} className="w-full mt-2 font-mono">
                    {createWithdrawal.isPending ? "PROCESSING..." : "SUBMIT_REQUEST"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog>
              <DialogTrigger asChild>
                <Button className="w-full font-mono flex items-center justify-center gap-2 h-12 bg-primary text-primary-foreground hover:bg-primary/90">
                  <ArrowDownToLine className="w-4 h-4" /> DEPOSIT_FUNDS
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Deposit Funds</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="bg-muted/40 border border-border rounded-lg p-4 space-y-3">
                    <p className="text-sm font-semibold font-mono">COMING_SOON</p>
                    <p className="text-sm text-muted-foreground">
                      On-chain BTC and USDT deposits are not yet active. Crypto deposit rails
                      will be enabled in an upcoming release. Once live, you will be able to
                      send BTC or USDT to a unique deposit address and your USD balance will
                      be credited automatically at the spot rate.
                    </p>
                    <p className="text-xs text-muted-foreground font-mono">
                      In the meantime, contact support to have your balance credited manually.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            {wallet?.pendingWithdrawalsUsd ? (
              <div className="text-center text-sm font-mono text-muted-foreground pt-2">
                Pending withdrawals: {formatMoney(wallet.pendingWithdrawalsUsd)}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="transactions" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto">
          <TabsTrigger value="transactions" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Ledger</TabsTrigger>
          <TabsTrigger value="withdrawals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Withdrawal Requests</TabsTrigger>
        </TabsList>
        
        <TabsContent value="transactions" className="pt-6">
          <Card className="bg-card/50 border-border/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="font-mono text-xs">TIME</TableHead>
                    <TableHead className="font-mono text-xs">TYPE</TableHead>
                    <TableHead className="font-mono text-xs">MEMO</TableHead>
                    <TableHead className="font-mono text-xs text-right">AMOUNT</TableHead>
                    <TableHead className="font-mono text-xs text-right">BALANCE_AFTER</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {walletLoading ? (
                     <TableRow>
                      <TableCell colSpan={5} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_LEDGER...</TableCell>
                    </TableRow>
                  ) : wallet?.transactions.length === 0 ? (
                     <TableRow>
                      <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                        No transactions found.
                      </TableCell>
                    </TableRow>
                  ) : wallet?.transactions.map(tx => (
                    <TableRow key={tx.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(tx.createdAt), "MMM d HH:mm:ss")}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase
                          ${tx.amountUsd > 0 ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-destructive/10 text-destructive border-destructive/20'}`}>
                          {tx.type.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {tx.memo}
                        {tx.relatedRentalId && <span className="ml-2 text-xs text-muted-foreground font-mono">#{tx.relatedRentalId}</span>}
                      </TableCell>
                      <TableCell className={`text-right font-mono font-medium ${tx.amountUsd > 0 ? 'text-green-500' : 'text-destructive'}`}>
                        {tx.amountUsd > 0 ? '+' : ''}{formatMoney(tx.amountUsd)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{formatMoney(tx.balanceAfterUsd)}</TableCell>
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
                    <TableHead className="font-mono text-xs">STATUS</TableHead>
                    <TableHead className="font-mono text-xs">DESTINATION</TableHead>
                    <TableHead className="font-mono text-xs text-right">AMOUNT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawalsLoading ? (
                     <TableRow>
                      <TableCell colSpan={4} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_REQUESTS...</TableCell>
                    </TableRow>
                  ) : withdrawals?.length === 0 ? (
                     <TableRow>
                      <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                        No withdrawal requests found.
                      </TableCell>
                    </TableRow>
                  ) : withdrawals?.map(wr => (
                    <TableRow key={wr.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(wr.createdAt), "MMM d HH:mm:ss")}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase
                          ${wr.status === 'approved' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 
                            wr.status === 'rejected' ? 'bg-destructive/10 text-destructive border-destructive/20' : 
                            'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'}`}>
                          {wr.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[200px] truncate" title={wr.destinationAddress}>
                        <span className="text-primary mr-2">{wr.asset}</span>
                        {wr.destinationAddress}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatMoney(wr.amountUsd)}</TableCell>
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
