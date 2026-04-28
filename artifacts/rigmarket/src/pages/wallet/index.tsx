import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  useGetMyWallet,
  useCreateWithdrawal,
  useListMyWithdrawals,
  useGetDepositAddresses,
  useListMyDeposits,
  useGetProcessorStatus,
  getGetMyWalletQueryKey,
  getListMyWithdrawalsQueryKey,
  getGetDepositAddressesQueryKey,
  getListMyDepositsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Wallet as WalletIcon, ArrowUpFromLine, ArrowDownToLine, Copy, RefreshCw, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Asset = "BTC" | "USDT";

function statusColor(status: string) {
  switch (status) {
    case "credited": return "bg-green-500/10 text-green-500 border-green-500/20";
    case "confirming": return "bg-blue-500/10 text-blue-500 border-blue-500/20";
    case "pending": return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
    case "failed":
    case "unmatched": return "bg-destructive/10 text-destructive border-destructive/20";
    default: return "bg-muted/50 text-muted-foreground";
  }
}

function DepositSection() {
  const { data, isLoading, refetch, isRefetching } = useGetDepositAddresses();
  const { data: processorStatus } = useGetProcessorStatus({ query: { refetchInterval: 60_000, queryKey: ["processorStatus"] } });
  const { data: deposits, isLoading: depositsLoading } = useListMyDeposits();
  const { toast } = useToast();
  const [selectedCurrency, setSelectedCurrency] = useState<"btc" | "usdt_trc20">("usdt_trc20");

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: `${label} copied to clipboard.` });
  };

  const addresses = data?.addresses ?? [];
  const processorConfigured = data?.processorConfigured ?? false;
  const processorReachable = processorStatus?.reachable ?? true;
  const activeAddress = addresses.find((a) => a.currency === selectedCurrency);

  return (
    <div className="space-y-6">
      {!processorConfigured && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-yellow-500 font-mono text-sm">PROCESSOR_NOT_CONFIGURED</p>
            <p className="text-sm text-muted-foreground mt-1">
              The crypto payment processor is not yet configured. Contact the site admin to enable deposits.
            </p>
          </div>
        </div>
      )}

      {processorConfigured && !processorReachable && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-500 font-mono text-sm">PROCESSOR_OUTAGE</p>
            <p className="text-sm text-muted-foreground mt-1">
              The payment processor is temporarily unreachable. Existing deposits will still be processed when connectivity is restored. New address provisioning may fail.
            </p>
          </div>
        </div>
      )}

      {processorConfigured && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 text-primary" />
                Deposit Address
              </CardTitle>
              <div className="flex gap-2">
                <div className="flex rounded-md border border-border overflow-hidden">
                  <button
                    onClick={() => setSelectedCurrency("usdt_trc20")}
                    className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                      selectedCurrency === "usdt_trc20"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    USDT-TRC20
                  </button>
                  <button
                    onClick={() => setSelectedCurrency("btc")}
                    className={`px-3 py-1.5 text-xs font-mono transition-colors border-l border-border ${
                      selectedCurrency === "btc"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    BTC
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => refetch()}
                  disabled={isRefetching}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground font-mono text-sm">LOADING_ADDRESS...</div>
            ) : !activeAddress?.ready ? (
              <div className="text-center py-8 text-muted-foreground">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-yellow-500" />
                <p className="font-mono text-sm">Address provisioning failed. Try refreshing.</p>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row gap-6 items-start">
                <div className="shrink-0 rounded-lg border border-border p-3 bg-white">
                  <QRCodeSVG
                    value={activeAddress.address}
                    size={160}
                    level="M"
                  />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase font-semibold font-mono mb-1">
                      {activeAddress.network} Address
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 font-mono text-xs bg-muted/50 border border-border rounded px-3 py-2 break-all">
                        {activeAddress.address}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        onClick={() => copyToClipboard(activeAddress.address, "Address")}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md bg-muted/30 border border-border/50 p-3">
                      <p className="text-xs text-muted-foreground font-mono uppercase mb-1">Minimum Deposit</p>
                      <p className="font-mono font-semibold">${activeAddress.minDepositUsd}</p>
                    </div>
                    <div className="rounded-md bg-muted/30 border border-border/50 p-3">
                      <p className="text-xs text-muted-foreground font-mono uppercase mb-1">Confirmations Required</p>
                      <p className="font-mono font-semibold">{activeAddress.requiredConfirmations}</p>
                    </div>
                  </div>
                  {activeAddress.expiresAt && (
                    <div className="rounded-md bg-muted/30 border border-border/50 p-3">
                      <p className="text-xs text-muted-foreground font-mono uppercase mb-1">Address Valid Until</p>
                      <p className="font-mono font-semibold text-sm">
                        {format(new Date(activeAddress.expiresAt), "MMM d, yyyy HH:mm z")}
                      </p>
                    </div>
                  )}
                  <div className="rounded-md bg-blue-500/10 border border-blue-500/20 p-3">
                    <p className="text-xs text-blue-400 font-mono">
                      Send only {activeAddress.currency === "btc" ? "BTC" : "USDT (TRC-20)"} to this address.
                      Your balance will be credited in USD at the spot rate after {activeAddress.requiredConfirmations} confirmation{activeAddress.requiredConfirmations !== 1 ? "s" : ""}.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-mono text-sm uppercase tracking-wider text-muted-foreground">
            Recent Deposits
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="font-mono text-xs">TIME</TableHead>
                <TableHead className="font-mono text-xs">CURRENCY</TableHead>
                <TableHead className="font-mono text-xs">AMOUNT</TableHead>
                <TableHead className="font-mono text-xs">STATUS</TableHead>
                <TableHead className="font-mono text-xs text-right">USD_VALUE</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {depositsLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground font-mono text-sm">
                    LOADING_DEPOSITS...
                  </TableCell>
                </TableRow>
              ) : !deposits || deposits.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    No deposits yet.
                  </TableCell>
                </TableRow>
              ) : (
                deposits.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {format(new Date(d.detectedAt), "MMM d HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px] uppercase">
                        {d.currency === "btc" ? "BTC" : "USDT-TRC20"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {Number(d.amountCrypto).toFixed(d.currency === "btc" ? 8 : 2)}
                      <span className="text-muted-foreground ml-1">{d.currency === "btc" ? "BTC" : "USDT"}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-mono text-[10px] uppercase ${statusColor(d.status)}`}>
                        {d.status === "confirming"
                          ? `confirming ${d.confirmations}/${d.requiredConfirmations}`
                          : d.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {d.amountUsd != null ? formatMoney(d.amountUsd) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Wallet() {
  const { data: wallet, isLoading: walletLoading } = useGetMyWallet();
  const { data: withdrawals, isLoading: withdrawalsLoading } = useListMyWithdrawals();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createWithdrawal = useCreateWithdrawal();

  const [withdrawAsset, setWithdrawAsset] = useState<Asset>("USDT");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard", description: `${label} copied.` });
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
                    <Select value={withdrawAsset} onValueChange={(v) => setWithdrawAsset(v as Asset)}>
                      <SelectTrigger className="font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USDT">USDT (TRC-20)</SelectItem>
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

            {wallet?.pendingWithdrawalsUsd ? (
              <div className="text-center text-sm font-mono text-muted-foreground pt-2">
                Pending withdrawals: {formatMoney(wallet.pendingWithdrawalsUsd)}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="deposit" className="w-full">
        <TabsList className="bg-muted/50 w-full justify-start border-b rounded-none px-0 h-auto">
          <TabsTrigger value="deposit" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Deposit</TabsTrigger>
          <TabsTrigger value="transactions" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Ledger</TabsTrigger>
          <TabsTrigger value="withdrawals" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none py-3 font-mono text-xs tracking-wider uppercase">Withdrawal Requests</TabsTrigger>
        </TabsList>

        <TabsContent value="deposit" className="pt-6">
          <DepositSection />
        </TabsContent>

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
                    <TableHead className="font-mono text-xs">TXID</TableHead>
                    <TableHead className="font-mono text-xs text-right">AMOUNT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawalsLoading ? (
                     <TableRow>
                      <TableCell colSpan={5} className="text-center py-10 text-muted-foreground font-mono text-sm">LOADING_REQUESTS...</TableCell>
                    </TableRow>
                  ) : withdrawals?.length === 0 ? (
                     <TableRow>
                      <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                        No withdrawal requests found.
                      </TableCell>
                    </TableRow>
                  ) : withdrawals?.map(wr => (
                    <TableRow key={wr.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{format(new Date(wr.createdAt), "MMM d HH:mm:ss")}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-[10px] uppercase
                          ${wr.status === 'sent' ? 'bg-green-500/10 text-green-500 border-green-500/20' :
                            wr.status === 'approved' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' :
                            wr.status === 'rejected' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                            'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'}`}>
                          {wr.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[160px] truncate" title={wr.destinationAddress}>
                        <span className="text-primary mr-2">{wr.asset}</span>
                        {wr.destinationAddress}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {wr.onChainTxid ? (
                          <button
                            onClick={() => copyToClipboard(wr.onChainTxid!, "Transaction ID")}
                            className="text-primary hover:underline font-mono text-xs max-w-[120px] truncate inline-block"
                            title={wr.onChainTxid}
                          >
                            {wr.onChainTxid.slice(0, 10)}…
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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
