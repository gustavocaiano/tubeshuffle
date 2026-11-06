export interface Guard {
  names: string[];
  keys: string[];
  config: { prefix?: string; cases?: string[]; evidence?: unknown; root: boolean };
  trace: {
    opens: { name: string; version: number }[];
    upgrades: { old: number; next: number }[];
    transactions: { stores: string[]; mode: string }[];
    local: { method: string; key: string }[];
    blocked: number; denied: number; deletes: number; network: number; schemaCalls: number;
  };
  faults: { read: boolean; write: boolean };
  negativeControls: (() => unknown)[];
  pending(): number;
  close(): void;
  snapshotLocal(): Record<string, string | null>;
  resetLocal(): void;
}
