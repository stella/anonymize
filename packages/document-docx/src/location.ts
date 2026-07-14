import type { DocxBlockLocation } from "./types";

const arraysEqual = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right.at(index));

export const docxLocationsEqual = (
  left: DocxBlockLocation,
  right: DocxBlockLocation,
): boolean => {
  if (
    left.type !== right.type ||
    left.part.type !== right.part.type ||
    left.part.path !== right.part.path ||
    left.blockIndex !== right.blockIndex ||
    !arraysEqual(left.xmlPath, right.xmlPath)
  ) {
    return false;
  }
  if (left.type === "paragraph" && right.type === "paragraph") {
    return true;
  }
  if (
    left.type === "table-cell-paragraph" &&
    right.type === "table-cell-paragraph"
  ) {
    return (
      arraysEqual(left.tablePath, right.tablePath) &&
      arraysEqual(left.rowPath, right.rowPath) &&
      arraysEqual(left.cellPath, right.cellPath)
    );
  }
  if (
    left.type === "text-box-paragraph" &&
    right.type === "text-box-paragraph"
  ) {
    return arraysEqual(left.textBoxPath, right.textBoxPath);
  }
  return false;
};

export const docxLocationKey = ({
  blockIndex,
  part,
}: DocxBlockLocation): string => `${part.path}\0${blockIndex}`;
