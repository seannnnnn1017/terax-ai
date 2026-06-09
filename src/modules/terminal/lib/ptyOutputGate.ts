export class PtyOutputGate {
  private pending: Uint8Array[] = [];
  private openForDelivery = false;
  private released = false;

  constructor(private readonly deliver: (bytes: Uint8Array) => void) {}

  receive(bytes: Uint8Array): void {
    if (this.released) return;
    if (this.openForDelivery) {
      this.deliver(bytes);
      return;
    }
    this.pending.push(bytes);
  }

  open(): void {
    if (this.released || this.openForDelivery) return;
    this.openForDelivery = true;
    const pending = this.pending;
    this.pending = [];
    for (const bytes of pending) this.deliver(bytes);
  }

  release(): void {
    this.released = true;
    this.pending = [];
  }
}
