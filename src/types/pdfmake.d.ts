// ---------------------------------------------------------------------------
// Type declarations for pdfmake (CommonJS singleton)
// ---------------------------------------------------------------------------

interface TFontDictionary {
  [fontName: string]: {
    normal: string;
    bold?: string;
    italics?: string;
    bolditalics?: string;
  };
}

interface TDocumentDefinitions {
  content: Array<Record<string, unknown>>;
  styles?: Record<string, unknown>;
  defaultStyle?: Record<string, unknown>;
  pageSize?: string;
  pageOrientation?: string;
  pageMargins?: Array<number>;
  [key: string]: unknown;
}

declare module "pdfmake" {
  interface OutputDocument {
    getBuffer(): Promise<Buffer>;
    getBase64(): Promise<string>;
    getDataUrl(): Promise<string>;
    write(filename: string): Promise<void>;
  }

  interface PdfMake {
    fonts: TFontDictionary;
    createPdf(
      docDefinition: TDocumentDefinitions,
      options?: Record<string, unknown>
    ): OutputDocument;
    virtualfs: Record<string, unknown>;
    urlAccessPolicy?: unknown;
    localAccessPolicy?: unknown;
  }

  const pdfmake: PdfMake;
  export default pdfmake;
}
