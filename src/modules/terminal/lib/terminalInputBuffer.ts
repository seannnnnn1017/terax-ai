const DEFAULT_CHAR_CAP = 64 * 1024;

export class TerminalInputBuffer {
  private value = "";

  constructor(private readonly charCap = DEFAULT_CHAR_CAP) {}

  push(data: string): void {
    if (!data || this.value.length >= this.charCap) return;
    const remaining = this.charCap - this.value.length;
    this.value += data.slice(0, remaining);
  }

  flush(write: (data: string) => void): void {
    if (!this.value) return;
    const data = this.value;
    this.value = "";
    write(data);
  }

  clear(): void {
    this.value = "";
  }

  get length(): number {
    return this.value.length;
  }
}
