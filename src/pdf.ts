
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { definePDFJSModule, getResolvedPDFJS } from 'unpdf';
import { createCanvas, Path2D, DOMMatrix } from '@napi-rs/canvas';
import { dirname, join } from 'node:path';
import { handleInput, bufferToArrayBuffer, ThumbnailError } from './utils';

const require = createRequire(import.meta.url);
const TARGET_WIDTH = 300;
const TARGET_HEIGHT = 360;

async function setupPdfjs() {
  await definePDFJSModule(async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // 🔑 Absoluuttinen polku workerille node_modulesista
    const workerPath = require.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
    );
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

    return pdfjs;
  });
}

// Polyfillit heti
(globalThis as any).Path2D = Path2D;
(globalThis as any).DOMMatrix = DOMMatrix;

function getPdfjsAssetUrls() {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts').replace(/\\/g, '/') + '/',
    cMapUrl: join(pdfjsRoot, 'cmaps').replace(/\\/g, '/') + '/',
  };
}

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext: { canvas: any }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: any; context: any }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    // @ts-expect-error cleanup
    canvasAndContext.canvas = null;
    // @ts-expect-error cleanup
    canvasAndContext.context = null;
  }
}

async function renderCenteredThumbnail(pdfData: Uint8Array) {
  await setupPdfjs();

  const { getDocument } = await getResolvedPDFJS();
  const canvasFactory = new NodeCanvasFactory();
  const { standardFontDataUrl, cMapUrl } = getPdfjsAssetUrls();

  const pdf = await getDocument({
    data: pdfData,
    canvasFactory,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  } as any).promise;

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });

  const scale = Math.min(
    TARGET_WIDTH / viewport.width,
    TARGET_HEIGHT / viewport.height,
  );

  const scaledWidth = Math.round(viewport.width * scale);
  const scaledHeight = Math.round(viewport.height * scale);
  const offsetX = Math.round((TARGET_WIDTH - scaledWidth) / 2);
  const offsetY = Math.round((TARGET_HEIGHT - scaledHeight) / 2);

  const renderViewport = page.getViewport({ scale });
  const { canvas: pageCanvas, context: pageCtx } = canvasFactory.create(
    scaledWidth,
    scaledHeight,
  );

  await page.render({
    canvasContext: pageCtx as never,
    viewport: renderViewport,
    canvas: pageCanvas as never,
  } as never).promise;

  const outputCanvas = createCanvas(TARGET_WIDTH, TARGET_HEIGHT);
  const outputCtx = outputCanvas.getContext('2d');
  outputCtx.fillStyle = '#FFFFFF';
  outputCtx.fillRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT);
  outputCtx.drawImage(pageCanvas, offsetX, offsetY, scaledWidth, scaledHeight);

  return Buffer.from(await outputCanvas.encode('webp'));
}

export async function getPdfThumbnail(source: string | Buffer) {
  try {
    const buffer = await handleInput(source);
    const thumbnailBuffer = await renderCenteredThumbnail(new Uint8Array(buffer));
    return bufferToArrayBuffer(thumbnailBuffer);
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError(
      `Failed to generate PDF thumbnail: ${String(error)}`,
      String(source),
      'PROCESSING_ERROR',
    );
  }
}
