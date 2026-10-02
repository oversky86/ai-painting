/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
