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
  // Current 60-s flush window — reset on each flush
  sharesAccepted: number;
  sharesRejected: number;
  difficultySum: number;
  currentDifficulty: number;
  lastShareAt: Date | null;
  // Cumulative totals for the whole rental lifetime — never reset
  sharesAcceptedLifetime: number;
  sharesRejectedLifetime: number;
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
  /** Number of mining.submit messages that were buffered and dropped (buffer full) */
  submitsDropped: number;
  /** Number of upstream connection errors observed for this session */
  upstreamErrors: number;
  /** Number of times the upstream disconnected / was lost during this session */
  upstreamDisconnects: number;
}

export interface ProxyAdminStatus {
  connectedRigs: ProxyRigEntry[];
  activeRoutes: number;
  /** Cumulative accepted+rejected share count across all connected rig sessions */
  totalSharesThisSession: number;
  /** Estimated shares/sec computed from the 60-s rolling share windows */
  currentSharesPerSec: number;
}
