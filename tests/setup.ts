// Global test setup: DOM shims for APIs happy-dom lacks, fake browser reset.
import { beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// --- DataTransfer shim (Chrome has it natively; happy-dom may not) ----------
class DataTransferItemListShim {
  private readonly dt: DataTransferShim;
  constructor(dt: DataTransferShim) {
    this.dt = dt;
  }
  add(file: File): void {
    this.dt.filesInternal.push(file);
  }
  get length(): number {
    return this.dt.filesInternal.length;
  }
}

export class DataTransferShim {
  readonly filesInternal: File[] = [];
  readonly items: DataTransferItemListShim;
  effectAllowed = 'all';
  dropEffect = 'none';
  constructor() {
    this.items = new DataTransferItemListShim(this) as unknown as DataTransferItemList;
  }
  get files(): FileList {
    return this.filesInternal as unknown as FileList;
  }
  get types(): readonly string[] {
    return this.filesInternal.length > 0 ? ['Files'] : [];
  }
  setData(): void {}
  getData(): string {
    return '';
  }
}

if (typeof globalThis.DataTransfer === 'undefined') {
  globalThis.DataTransfer = DataTransferShim as unknown as typeof DataTransfer;
}

// --- DragEvent shim ---------------------------------------------------------
if (typeof globalThis.DragEvent === 'undefined') {
  class DragEventShim extends Event {
    readonly dataTransfer: DataTransfer | null;
    constructor(type: string, init?: EventInit & { dataTransfer?: DataTransfer | null }) {
      super(type, init);
      this.dataTransfer = init?.dataTransfer ?? null;
    }
  }
  globalThis.DragEvent = DragEventShim as unknown as typeof DragEvent;
}

beforeEach(() => {
  fakeBrowser.reset();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});
