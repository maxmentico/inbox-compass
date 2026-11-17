// Isolated, deliberately over-conservative residue check. It does not redact retained digests or
// unknown data. It cannot certify a production schema or migration and must not be wired live.
import type { ResidueInspector } from './synthetic-alias-purge';

// Unknown tables fail closed. Adding a table requires an explicit audit and new tests.
const SAFE=new Set([
 'core_active','core_jobs','core_steps','core_tokens','core_stage_budget','core_stages','core_chunks','core_final',
 'gen_head','gen_key_heads','gen_chunks','gen_versions','gen_prepared','gen_preparation_ids','gen_selected',
 'domain_accounts','domain_job_bindings','domain_job_accounts','domain_plans',
 'coordinated_accounts','coordinated_identities','coordinated_incarnations','coordinated_revocations','coordinated_oauth_barrier',
 'owner_settings','owner_settings_hash','owner_settings_chunks','owner_done','purge_head_ids',
 'trusted_source','trusted_reference','trusted_reference_pages',
 'synthetic_snapshots','synthetic_fragments','synthetic_checkpoints','synthetic_source_proof','synthetic_packed_proof',
 'synthetic_stage_cursor','synthetic_stage_page','synthetic_job_stage_binding','synthetic_partial_driver','synthetic_partial_pages',
 'synthetic_reference_header','synthetic_reference_op','synthetic_reference_chunk','synthetic_segment_certificate',
 'sgen_build','sgen_index','sgen_pages','sgen_committed','sgen_head',
 'seg_outputs','seg_parts','seg_budget',
]);
const REQUIRED=['core_jobs','core_steps','core_chunks','core_stages','gen_key_heads','gen_chunks','domain_accounts','domain_job_accounts','coordinated_accounts','coordinated_revocations','owner_done'];
// These tables may contain mixed-account content, output commitments or metadata whose provenance
// cannot be attributed safely. This prototype refuses completion until they are empty.
const UNCLASSIFIED=[
 'gen_prepared','domain_plans','trusted_source','trusted_reference','trusted_reference_pages',
 'synthetic_snapshots','synthetic_fragments','synthetic_checkpoints','synthetic_source_proof','synthetic_packed_proof',
 'synthetic_stage_cursor','synthetic_stage_page','synthetic_job_stage_binding','synthetic_partial_driver','synthetic_partial_pages',
 'synthetic_reference_header','synthetic_reference_op','synthetic_reference_chunk','synthetic_segment_certificate',
 'sgen_build','sgen_index','sgen_pages','sgen_committed','sgen_head','seg_outputs','seg_parts','seg_budget',
];
/** Same-transaction proof that intentionally rejects retained digests and unidentified artifacts. */
export function conservativePurgeInspector():ResidueInspector {
 return (sql,alias)=>{
  const tables=sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray().map(r=>r.name);
  const present=new Set(tables);
  if(tables.some(name=>!SAFE.has(name))||REQUIRED.some(name=>!present.has(name)))return false;
  if(sql.exec('SELECT alias FROM coordinated_revocations WHERE alias=? LIMIT 1',alias).toArray().length)return false;
  // Old job config keeps mailbox identity. It must be separately retired before alias reuse.
  if(sql.exec('SELECT job FROM core_jobs WHERE json_valid(config)=0 LIMIT 1').toArray().length)return false;
  if(sql.exec("SELECT j.job FROM core_jobs j,json_each(j.config,'$.mailboxes') m WHERE json_extract(m.value,'$.alias')=? LIMIT 1",alias).toArray().length)return false;
  if(sql.exec("SELECT key FROM gen_key_heads WHERE key>=? AND key<? LIMIT 1",'digest:','digest;').toArray().length || sql.exec("SELECT key FROM gen_chunks WHERE key>=? AND key<? LIMIT 1",'digest:','digest;').toArray().length)return false;
  for(const table of UNCLASSIFIED)if(present.has(table)&&sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length)return false;
  return true;
 };
}
