/** Native addons are validated at the binding boundary before use. */
declare module "*.node" {
  const binding: unknown;
  export = binding;
}
