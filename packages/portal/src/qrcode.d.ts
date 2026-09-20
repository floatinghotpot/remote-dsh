/**
 * qrcode 的**本地最小声明**（替代 `@types/qrcode`）。
 *
 * 为什么不用 `@types/qrcode`：它的 `dependencies` 里有 `@types/node`，会把整个 Node 类型图带进 portal
 * 的程序里 ⇒ 浏览器代码写 `Buffer`/`process` 也能过 tsc，而关卡本该拦住这类错误
 * （见 doc/fix/20260921-portal-typecheck-gate/，审查 ② F2）。
 *
 * 只声明 portal 实际用到的子集：`QRCode.toDataURL(text, { width, margin })`（pages.tsx:1054、1858）。
 * 签名照抄 `@types/qrcode` 的 `toDataURL(text: string | QRCodeSegment[], options?: QRCodeToDataURLOptions): Promise<string>`
 * （字符串入参场景）。新增用法时请对照上游 d.ts 补齐，不要凭猜。
 */
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "low" | "medium" | "quartile" | "high";
    type?: "image/png" | "image/jpeg" | "image/webp";
  }

  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;

  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  };
  export default QRCode;
}
