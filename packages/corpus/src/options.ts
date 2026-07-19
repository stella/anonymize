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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseIsoDateOption = (name: string, value: string): string => {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`--${name} must use YYYY-MM-DD; got ${value}`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`--${name} must be a valid date; got ${value}`);
  }
  return value;
};

export type DateRange = {
  startDate: string;
  endDate: string;
};

export const dateRangeOptions = ({
  startDate,
  endDate,
}: {
  startDate: string | undefined;
  endDate: string | undefined;
}): DateRange | undefined => {
  if (startDate === undefined && endDate === undefined) {
    return undefined;
  }
  if (startDate === undefined || endDate === undefined) {
    throw new Error("--start-date and --end-date must be provided together");
  }

  const parsedStartDate = parseIsoDateOption("start-date", startDate);
  const parsedEndDate = parseIsoDateOption("end-date", endDate);
  if (parsedStartDate > parsedEndDate) {
    throw new Error("--start-date must be on or before --end-date");
  }
  return { startDate: parsedStartDate, endDate: parsedEndDate };
};
