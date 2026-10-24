// Dinero interno en micro-dólares (enteros). Los casinos reciben montos con 2 decimales.
export const MICRO = 1_000_000;
export const CENT = 10_000;

export const ceilCent = (m: number) => Math.ceil(m / CENT) * CENT;
export const floorCent = (m: number) => Math.floor(m / CENT) * CENT;
export const toDecimal = (m: number) => (m / MICRO).toFixed(2);
export const fromDecimal = (s: string | number) => Math.round(Number(s) * MICRO);
export const usd = (m: number) => m / MICRO;
export const feeOf = (notional: number, bps: number) => Math.ceil((notional * bps) / 10_000);
