/** Bun embeds files imported with `with { type: "file" }`
 * and resolves the import to the embedded path. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
