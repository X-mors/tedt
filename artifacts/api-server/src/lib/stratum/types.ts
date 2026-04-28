export interface JsonRpcMessage {
  id: number | string | null;
  method?: string;
  params?: unknown[];
  result?: unknown;
  error?: unknown;
}

export interface ShareWindow {
  rentalId: number;
  rigId: number;
  startedAt: number;
  sharesAccepted: number;
  sharesRejected: number;
  difficultySum: number;
  currentDifficulty: number;
  lastShareAt: Date | null;
}

export interface ProxyRigEntry {
  rigId: number;
  rigName: string;
  connectedAt: Date;
  authorized: boolean;
  rentalId: number | null;
  sharesAccepted: number;
  sharesRejected: number;
  lastShareAt: Date | null;
  upstreamConnected: boolean;
}

export interface ProxyAdminStatus {
  connectedRigs: ProxyRigEntry[];
  activeRoutes: number;
  totalSharesPerSec: number;
}
