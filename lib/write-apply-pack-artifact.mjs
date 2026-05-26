/**
 * Shared helper: validate and write a schema-typed apply-pack artifact JSON file.
 *
 * Usage:
 *   import { writeApplyPackArtifact } from './write-apply-pack-artifact.mjs';
 *   const { path, validationErrors } = await writeApplyPackArtifact('form-fields', slug, data);
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCHEMAS_DIR = join(__dirname, 'schemas');
const PACK_DIR = join(ROOT, 'apply-pack');

// Lazy-load ajv only once (Draft 2020-12 via ajv/dist/2020)
let _ajv = null;
async function getAjv() {
  if (_ajv) return _ajv;
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  _ajv = ajv;
  return ajv;
}

const SCHEMA_MAP = {
  'form-fields':    'form-fields.schema.json',
  'cv-tailored':   'cv-tailored.schema.json',
  'cover-letter':  'cover-letter.schema.json',
  'linkedin-dm':   'linkedin-dm.schema.json',
  'impact-doc':    'impact-doc.schema.json',
  'references':    'references.schema.json',
  'referrals':     'referrals.schema.json',
  'why-statement': 'why-statement.schema.json',
};

/**
 * Write a schema-typed artifact JSON to apply-pack/<slug>/<artifactType>.json.
 *
 * @param {string} artifactType - one of SCHEMA_MAP's keys
 * @param {string} slug - apply-pack directory slug
 * @param {object} data - artifact payload (will be validated)
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - if true, validate only; do not write
 * @param {boolean} [opts.failOnValidationError=false] - throw if schema invalid
 * @returns {{ path: string, validationErrors: string[] | null }}
 */
export async function writeApplyPackArtifact(artifactType, slug, data, opts = {}) {
  const { dryRun = false, failOnValidationError = false } = opts;

  const schemaFile = SCHEMA_MAP[artifactType];
  if (!schemaFile) throw new Error(`Unknown artifact type: ${artifactType}`);

  const schemaPath = join(SCHEMAS_DIR, schemaFile);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

  const ajv = await getAjv();
  // Reuse cached validator if schema was already compiled (ajv caches by $id)
  const validate = ajv.getSchema(schema.$id) || ajv.compile(schema);
  const valid = validate(data);

  let validationErrors = null;
  if (!valid) {
    validationErrors = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
    if (failOnValidationError) {
      throw new Error(`Schema validation failed for ${artifactType}/${slug}:\n${validationErrors.join('\n')}`);
    }
  }

  const outDir = join(PACK_DIR, slug);
  const outPath = join(outDir, `${artifactType}.json`);

  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  return { path: outPath, validationErrors };
}

/**
 * Build a minimal base artifact envelope for any type.
 */
export function makeArtifactBase(agentName, slug, overrides = {}) {
  return {
    schema_version: '1.0.0',
    agent_name: agentName,
    slug,
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}
