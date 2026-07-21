export const runSealedBoundary = async <Result>(
  operation: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await run();
  } catch {
    throw new Error(`${operation} failed; sealed details suppressed`);
  }
};
