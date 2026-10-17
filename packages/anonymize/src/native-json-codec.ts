export type Check<T = unknown> = (value: unknown) => value is T;
export type Fields<T> = { [Key in keyof T]-?: Check<T[Key]> };
type Checked<Guard> = Guard extends Check<infer Value> ? Value : never;
type OptionalKeys<Shape> = {
  [Key in keyof Shape]-?: undefined extends Checked<Shape[Key]> ? Key : never;
}[keyof Shape];
type CheckedObject<Shape> = {
  [Key in Exclude<keyof Shape, OptionalKeys<Shape>>]: Checked<Shape[Key]>;
} & {
  [Key in OptionalKeys<Shape>]?: Exclude<Checked<Shape[Key]>, undefined>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string =>
  typeof value === "string";
export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
export const optional =
  <Value>(check: Check<Value>): Check<Value | undefined> =>
  (value): value is Value | undefined =>
    value === undefined || check(value);
export const oneOf =
  <Guards extends Check[]>(...checks: Guards): Check<Checked<Guards[number]>> =>
  (value): value is Checked<Guards[number]> =>
    checks.some((check) => check(value));
export const literalUnion =
  <Values extends Record<string, true>>(
    values: Values,
  ): Check<Extract<keyof Values, string>> =>
  (value): value is Extract<keyof Values, string> =>
    typeof value === "string" && Object.hasOwn(values, value);
export const arrayOf =
  <Value>(check: Check<Value>): Check<Value[]> =>
  (value): value is Value[] =>
    Array.isArray(value) && value.every((entry: unknown) => check(entry));
export const recordOf =
  <Value>(check: Check<Value>): Check<Record<string, Value>> =>
  (value): value is Record<string, Value> =>
    isRecord(value) && Object.values(value).every(check);
export const objectOf =
  <Shape extends Record<string, Check>>(
    fields: Shape,
  ): Check<CheckedObject<Shape>> =>
  (value): value is CheckedObject<Shape> => {
    if (!isRecord(value)) return false;
    return Object.entries(fields).every(([key, check]) => check(value[key]));
  };
