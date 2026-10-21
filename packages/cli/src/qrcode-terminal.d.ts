/** Minimal typings for `qrcode-terminal` (the package ships no types). */
declare module "qrcode-terminal" {
  /** Render `text` as a terminal QR code; `small: true` uses half-block characters. */
  export function generate(text: string, opts?: { small?: boolean }, cb?: (qrcode: string) => void): void;
}
