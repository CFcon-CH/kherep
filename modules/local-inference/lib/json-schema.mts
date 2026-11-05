import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { within } from "./profile.mts";

// The strict subset of JSON Schema the runner forwards as
// response_format.type=json_schema. Every field is validated at load time by
// validateSchemaTree; the optional types describe a node that passed.
export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  items?: SchemaNode;
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  pattern?: string;
  uniqueItems?: boolean;
  [key: string]: unknown;
}

export interface ResponseFormat {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: SchemaNode };
}

export interface LoadedSchema { sourcePath: string; responseFormat: ResponseFormat }

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 1_000;
const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const SUPPORTED_KEYWORDS = new Set([
  "$comment", "$id", "$schema", "additionalProperties", "const", "default", "description", "enum",
  "examples", "exclusiveMaximum", "exclusiveMinimum", "items", "maximum", "maxItems", "maxLength",
  "maxProperties", "minimum", "minItems", "minLength", "minProperties", "multipleOf", "pattern",
  "properties", "readOnly", "required", "title", "type", "uniqueItems", "writeOnly",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectTyped(schema: SchemaNode): boolean {
  return schema.type === "object"
    || (Array.isArray(schema.type) && schema.type.includes("object"))
    || Object.hasOwn(schema, "properties")
    || Object.hasOwn(schema, "required")
    || Object.hasOwn(schema, "additionalProperties");
}

function declares(schema: SchemaNode, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function validateStrictObject(schema: SchemaNode): void {
  if (!declares(schema, "object")) {
    throw new Error("object constraints require object type");
  }
  if (!isObject(schema.properties)) throw new Error("object properties must be an object");
  if (schema.additionalProperties !== false) throw new Error("objects must reject additional properties");
  if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string")) {
    throw new Error("object required must be a string array");
  }
  const properties = Object.keys(schema.properties);
  const required = new Set(schema.required);
  if (required.size !== schema.required.length
      || properties.some((name) => !required.has(name))
      || schema.required.some((name) => !Object.hasOwn(schema.properties as object, name))) {
    throw new Error("every object property must be required exactly once");
  }
}

function validateSchemaTree(root: unknown): void {
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (!isObject(value)) throw new Error("schema nodes must be objects");
    const schema = value as SchemaNode;
    nodes++;
    if (depth > MAX_SCHEMA_DEPTH || nodes > MAX_SCHEMA_NODES) throw new Error("schema is too complex");
    if (Object.keys(schema).some((key) => !SUPPORTED_KEYWORDS.has(key))) {
      throw new Error("schema keyword is unsupported");
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (types.length === 0 || new Set(types).size !== types.length
          || types.some((type) => typeof type !== "string" || !JSON_TYPES.has(type))) {
        throw new Error("schema type is invalid");
      }
    }
    if (schema.type === undefined && schema.enum === undefined && schema.const === undefined) {
      throw new Error("schema nodes must constrain a value");
    }
    for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"]) {
      const bound = schema[key];
      if (bound !== undefined && (!Number.isInteger(bound) || Number(bound) < 0)) {
        throw new Error(`${key} must be a non-negative integer`);
      }
    }
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
      if (schema[key] !== undefined && !Number.isFinite(schema[key])) throw new Error(`${key} must be finite`);
    }
    if (schema.multipleOf !== undefined && (!Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0)) {
      throw new Error("multipleOf must be positive");
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") throw new Error("pattern must be a string");
      RegExp(schema.pattern); // Compile for syntax validation without executing the supplied pattern.
    }
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error("enum must be a non-empty array");
      const values = schema.enum;
      const hasDuplicate = values.some((item, index) => values.slice(0, index)
        .some((prior) => isDeepStrictEqual(item, prior)));
      if (hasDuplicate) throw new Error("enum values must be unique");
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
      throw new Error("uniqueItems must be boolean");
    }
    for (const key of ["readOnly", "writeOnly"]) {
      if (schema[key] !== undefined && typeof schema[key] !== "boolean") throw new Error(`${key} must be boolean`);
    }
    for (const key of ["$comment", "$id", "$schema", "description", "title"]) {
      if (schema[key] !== undefined && typeof schema[key] !== "string") throw new Error(`${key} must be a string`);
    }
    if (schema.examples !== undefined && !Array.isArray(schema.examples)) throw new Error("examples must be an array");
    if ((schema.minItems !== undefined || schema.maxItems !== undefined || schema.uniqueItems !== undefined
        || schema.items !== undefined) && !declares(schema, "array")) throw new Error("array constraints require array type");
    if (declares(schema, "array") && schema.items === undefined) throw new Error("array schemas require items");
    if ((schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined)
        && !declares(schema, "string")) throw new Error("string constraints require string type");
    if ((schema.minimum !== undefined || schema.maximum !== undefined || schema.exclusiveMinimum !== undefined
        || schema.exclusiveMaximum !== undefined || schema.multipleOf !== undefined)
        && !declares(schema, "number") && !declares(schema, "integer")) {
      throw new Error("numeric constraints require numeric type");
    }
    if (objectTyped(schema)) validateStrictObject(schema);

    if (schema.properties) {
      for (const child of Object.values(schema.properties)) visit(child, depth + 1);
    }
    if (schema.items !== undefined) visit(schema.items, depth + 1);
  }

  if (!isObject(root) || root.type !== "object") throw new Error("root type must be object");
  visit(root, 0);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function matchesSchema(value: unknown, schema: SchemaNode): boolean {
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(value, item))) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) return false;
  }
  if (isObject(value) && objectTyped(schema)) {
    const keys = Object.keys(value);
    const properties = schema.properties || {};
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) return false;
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
    if (!(schema.required || []).every((key) => Object.hasOwn(value, key))) return false;
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesSchema(value[key], properties[key])) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    const hasDuplicate = schema.uniqueItems && value.some((item, index) => value.slice(0, index)
      .some((prior) => isDeepStrictEqual(item, prior)));
    if (hasDuplicate) return false;
    const items = schema.items;
    if (items) for (const item of value) if (!matchesSchema(item, items)) return false;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-12) return false;
  }
  return true;
}

export function loadResponseFormat(file: unknown, workspace: string): LoadedSchema {
  try {
    if (typeof file !== "string" || file.length === 0) throw new Error("schema file is required");
    const realWorkspace = fs.realpathSync(path.resolve(workspace));
    const realFile = fs.realpathSync(path.resolve(file));
    if (!within(realFile, realWorkspace)) throw new Error("schema file must be inside workspace");
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_SCHEMA_BYTES) throw new Error("schema file is invalid");
    const bytes = fs.readFileSync(realFile);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const schema: unknown = JSON.parse(text);
    validateSchemaTree(schema);
    return {
      sourcePath: realFile,
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "structured_response", strict: true, schema: schema as SchemaNode },
      },
    };
  } catch {
    throw new Error("Invalid strict JSON schema");
  }
}
