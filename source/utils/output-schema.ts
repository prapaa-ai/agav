import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type OutputSchema = Record<string, unknown> | boolean;

/** Load an inline JSON Schema or an @file reference resolved from the current directory. */
export async function loadOutputSchema(value: string): Promise<OutputSchema> {
  if (!value) {
    throw new Error("--output-schema requires an inline JSON schema or @file path");
  }

  let source = value;
  if (value.startsWith("@")) {
    const path = value.slice(1);
    if (!path) {
      throw new Error("--output-schema @file reference is missing a path");
    }
    source = await readFile(resolve(path), "utf-8");
  }

  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    const origin = value.startsWith("@") ? `schema file ${value.slice(1)}` : "inline schema";
    throw new Error(`Invalid JSON in ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
    throw new Error("JSON Schema must be an object or boolean");
  }

  return schema as OutputSchema;
}

export interface OutputValidationResult {
  valid: boolean;
  value?: unknown;
  errors?: ErrorObject[];
  parseError?: string;
}

/** Compile a JSON Schema once and return a validator for parsed agent output. */
export function createOutputValidator(schema: OutputSchema): ValidateFunction {
  return new Ajv({ allErrors: true }).compile(schema);
}

/** Require the response to be JSON and validate its parsed value against the schema. */
export function validateOutput(text: string, validate: ValidateFunction): OutputValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      valid: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const valid = validate(value);
  return valid
    ? { valid: true, value }
    : { valid: false, value, errors: validate.errors ?? [] };
}

export function formatValidationErrors(result: OutputValidationResult): string {
  if (result.parseError) return `Response is not valid JSON: ${result.parseError}`;
  if (!result.errors?.length) return "Response does not match the requested JSON Schema.";
  return result.errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}
