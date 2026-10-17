export const requirePresent = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected test value to be present");
  }
  return value;
};
