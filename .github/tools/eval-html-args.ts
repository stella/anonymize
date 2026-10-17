export const parseEvalHtmlArgs = (args: readonly string[]) => {
  let outputPath = "/tmp/eval-report.html";
  let watchMode = false;
  const inputs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args.at(index);
    if (argument === undefined) throw new Error("Missing evaluation argument");
    if (argument === "--output") {
      const value = args.at(index + 1);
      if (value === undefined || value === "")
        throw new Error("--output requires a non-empty path");
      outputPath = value;
      index++;
    } else if (argument === "--watch" || argument === "-w") {
      watchMode = true;
    } else {
      inputs.push(argument);
    }
  }
  return { outputPath, watchMode, inputs };
};
