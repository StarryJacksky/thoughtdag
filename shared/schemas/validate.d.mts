export interface ValidationError {
  /** JSON pointer into the value; '' is the value itself */
  path: string;
  /** the schema keyword that failed, or 'kind' for a kind nobody defined */
  keyword: string;
  message: string;
}

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

export interface Validator {
  /** every kind that can be validated by name, sorted */
  kinds(): string[];
  validate(kind: string, value: unknown): ValidationResult;
}

export function createValidator(schemas: readonly object[]): Validator;

export type VersionAccess = 'read-write' | 'read-only' | 'migrate' | 'unsupported';

export function versionAccess(found: unknown, supported: string): VersionAccess;
