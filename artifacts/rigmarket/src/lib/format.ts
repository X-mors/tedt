export const formatMoney = (amount: number) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
};

export const formatHashrate = (hashrate: number, unit: string) => {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(hashrate) + " " + unit;
};

export const formatSeconds = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
};
