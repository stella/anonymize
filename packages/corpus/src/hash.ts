export const sha256Hex = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
