// pdf-parse ships no types. Import the lib entry directly: the package index runs a self-test that
// reads a fixture PDF when it thinks it is the main module, which under ESM it always does.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult { numpages: number; numrender: number; info: any; metadata: any; text: string; version: string }
  function pdfParse(data: Buffer, options?: { max?: number }): Promise<PdfParseResult>;
  export default pdfParse;
}
