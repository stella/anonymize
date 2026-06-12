export const positiveIntegerOption = ({
  name,
  value,
  fallback,
}: {
  name: string;
  value: string | undefined;
  fallback: number;
}): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer; got ${value}`);
  }
  return parsed;
};
