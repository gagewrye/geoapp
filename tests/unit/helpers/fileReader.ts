/** Minimal FileReader for Node, enough for geotiff.js fromBlob (readAsArrayBuffer + onload). */
export class NodeFileReader {
  result: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onabort: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then((b) => { this.result = b; this.onload?.(); }, (e: unknown) => this.onerror?.(e));
  }
  abort(): void { this.onabort?.(); }
}
