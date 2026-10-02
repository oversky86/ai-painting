import convertHeic from "heic-convert";
import sharp from "sharp";

/**
 * Customer storefront photo types. JPEG, PNG, and WebP are stored as uploaded.
 * Other still images are transcoded to JPEG before storage because the working
 * copy is always originals/.../original.jpg with content type image/jpeg.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/x-bmp": "bmp",
  "image/tiff": "tiff",
  "image/tif": "tiff",
  "image/x-tiff": "tiff",
};

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const PASSTHROUGH = new Set(["image/jpeg", "image/png", "image/webp"]);

const JPEG_QUALITY = 90;

export class CustomerPhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerPhotoError";
  }
}

function normalizeType(contentType: string): string {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  if (type === "image/tif" || type === "image/x-tiff") return "image/tiff";
  if (type === "image/x-ms-bmp" || type === "image/x-bmp") return "image/bmp";
  if (type === "image/heic-sequence") return "image/heic";
  if (type === "image/heif-sequence") return "image/heif";
  return type;
}

function extensionFromName(name: string): string {
  const base = name.split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Declared MIME, or the extension when the browser sends an empty or generic type. */
export function customerPhotoContentType(file: { type: string; name: string }): string | null {
  const type = String(file.type || "").toLowerCase().split(";")[0].trim();
  if (type && EXTENSION_BY_TYPE[type]) return normalizeType(type);
  const generic =
    !type ||
    type === "application/octet-stream" ||
    type === "binary/octet-stream" ||
    type === "application/binary";
  if (!generic) return null;
  const inferred = TYPE_BY_EXTENSION[extensionFromName(file.name)];
  return inferred ? normalizeType(inferred) : null;
}

function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const gif = buffer.toString("ascii", 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (buffer.length >= 4) {
    const le = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const be = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (le || be) return "image/tiff";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (
      brand.startsWith("hei") ||
      brand.startsWith("hevc") ||
      brand.startsWith("mif") ||
      brand === "msf1"
    ) {
      return "image/heic";
    }
  }
  return null;
}

async function toJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { pages: 1, failOn: "error" }).autoOrient().jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch (error) {
    console.error("[upload] JPEG transcode failed:", error instanceof Error ? error.message : error);
    throw new CustomerPhotoError("Could not read this image. Please try a JPG or PNG.");
  }
}

async function jpegFromHeic(buffer: Buffer): Promise<Buffer> {
  try {
    const png = Buffer.from(await convertHeic({ buffer, format: "PNG" }));
    return await sharp(png).autoOrient().jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch (error) {
    console.error("[upload] HEIC/HEIF decode failed:", error instanceof Error ? error.message : error);
    throw new CustomerPhotoError(
      "Could not read this HEIC/HEIF photo. Please export it as JPG and try again.",
    );
  }
}

function unreadableBmp(): CustomerPhotoError {
  return new CustomerPhotoError("Could not read this BMP image. Please export it as JPG and try again.");
}

/** Uncompressed 8-bit, 24-bit, and 32-bit BMP. Sharp's prebuild cannot decode BMP. */
function decodeBmp(buffer: Buffer): { data: Buffer; width: number; height: number } {
  if (buffer.length < 54 || buffer.toString("ascii", 0, 2) !== "BM") throw unreadableBmp();
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  if (dibSize < 40 || pixelOffset >= buffer.length) throw unreadableBmp();
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const planes = buffer.readUInt16LE(26);
  const bitCount = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (width <= 0 || height <= 0 || planes !== 1 || compression !== 0) throw unreadableBmp();
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) throw unreadableBmp();
  if (width * height > 40_000_000) throw unreadableBmp();

  const rowStride = Math.ceil((width * bitCount) / 32) * 4;
  const out = Buffer.alloc(width * height * 3);
  const paletteOffset = 14 + dibSize;

  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + srcY * rowStride;
    if (rowStart < 0 || rowStart + (bitCount === 8 ? width : width * (bitCount / 8)) > buffer.length) {
      throw unreadableBmp();
    }
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 3;
      if (bitCount === 24) {
        const i = rowStart + x * 3;
        out[dst] = buffer[i + 2];
        out[dst + 1] = buffer[i + 1];
        out[dst + 2] = buffer[i];
      } else if (bitCount === 32) {
        const i = rowStart + x * 4;
        out[dst] = buffer[i + 2];
        out[dst + 1] = buffer[i + 1];
        out[dst + 2] = buffer[i];
      } else {
        const entry = paletteOffset + buffer[rowStart + x] * 4;
        if (entry + 2 >= buffer.length) throw unreadableBmp();
        out[dst] = buffer[entry + 2];
        out[dst + 1] = buffer[entry + 1];
        out[dst + 2] = buffer[entry];
      }
    }
  }

  return { data: out, width, height };
}

async function jpegFromBmp(buffer: Buffer): Promise<Buffer> {
  const decoded = decodeBmp(buffer);
  try {
    return await sharp(decoded.data, {
      raw: { width: decoded.width, height: decoded.height, channels: 3 },
    })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch (error) {
    console.error("[upload] BMP encode failed:", error instanceof Error ? error.message : error);
    throw unreadableBmp();
  }
}

export async function toStoredCustomerPhoto(buffer: Buffer, declaredType: string): Promise<Buffer> {
  const type = sniffImageType(buffer) || normalizeType(declaredType);
  if (PASSTHROUGH.has(type)) return buffer;
  if (type === "image/heic" || type === "image/heif") return jpegFromHeic(buffer);
  if (type === "image/bmp") return jpegFromBmp(buffer);
  if (type === "image/gif" || type === "image/avif" || type === "image/tiff") return toJpeg(buffer);
  throw new CustomerPhotoError("Could not read this image. Please try a JPG or PNG.");
}
