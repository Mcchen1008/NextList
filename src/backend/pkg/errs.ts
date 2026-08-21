export enum ErrorCode {
  OK = 200,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  InternalError = 500,

  // Custom AList/NextList codes
  InvalidConfig = 1001,
  InvalidStorage = 1002,
  StorageNotReady = 1003,
  PathNotFound = 1004,
  AccountNotFound = 1005,
  TaskNotFound = 1006,
}

export class NextListNextError extends Error {
  constructor(
    public code: ErrorCode,
    public message: string,
    public originalError?: any,
  ) {
    super(message)
    this.name = "NextListNextError"
  }
}

export const Errs = {
  PathNotFound: new NextListNextError(
    ErrorCode.PathNotFound,
    "Path not found",
  ),
  NotReady: new NextListNextError(
    ErrorCode.StorageNotReady,
    "Storage not ready",
  ),
  InvalidConfig: new NextListNextError(
    ErrorCode.InvalidConfig,
    "Invalid configuration",
  ),
  Unauthorized: new NextListNextError(
    ErrorCode.Unauthorized,
    "Unauthorized access",
  ),
  Forbidden: new NextListNextError(
    ErrorCode.Forbidden,
    "Permission denied",
  ),
}
