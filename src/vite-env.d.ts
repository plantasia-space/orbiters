/// <reference types="vite/client" />
// Gives tsc the Vite ambient module types (`*.css` side-effect imports,
// `import.meta.env`, etc.) so the React migration can `import "…/styles.css"` and
// type-check clean under `tsc --noEmit`. Vite/esbuild handle the actual transform.

// `qrcode` ships no type declarations; declare the narrow slice the React pairing
// dialog uses (Tier-1 migration). The legacy WebRTCManager imports it the same way.
declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
  }
  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  };
  export default QRCode;
}
