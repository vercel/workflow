// smithy-typescript generated code
/**
 * @public
 * @enum
 */
export const ResolveData = {
  /**
   * Resolve all payload fields.
   */
  ALL: "all",
  /**
   * Omit payload fields such as input, output, error, and metadata.
   */
  NONE: "none",
} as const;
/**
 * @public
 */
export type ResolveData = (typeof ResolveData)[keyof typeof ResolveData];

/**
 * @public
 * @enum
 */
export const RunStatus = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed",
  PENDING: "pending",
  RUNNING: "running",
} as const;
/**
 * @public
 */
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * @public
 * @enum
 */
export const StepStatus = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed",
  PENDING: "pending",
  RUNNING: "running",
} as const;
/**
 * @public
 */
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/**
 * @public
 * @enum
 */
export const SortOrder = {
  ASC: "asc",
  DESC: "desc",
} as const;
/**
 * @public
 */
export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder];
