// Synthetic in-memory SQLite only. Run with vite-node; no production data or credentials.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {conservativePurgeInspector} from '../../src/conservative-purge-inspector.ts';
const db=new DatabaseSync(':memory:');
const sql={exec(query,...args){const rows=db.prepare(query).all(...args);return{toArray:()=>rows};}};
for(const ddl of [
 'CREATE TABLE core_jobs(job TEXT,config TEXT)', 'CREATE TABLE core_steps(job TEXT,alias TEXT)', 'CREATE TABLE core_chunks(job TEXT,alias TEXT)', 'CREATE TABLE core_stages(job TEXT,alias TEXT)',
 'CREATE TABLE gen_key_heads(key TEXT)', 'CREATE TABLE gen_chunks(key TEXT)', 'CREATE TABLE domain_accounts(alias TEXT)', 'CREATE TABLE domain_job_accounts(job TEXT,alias TEXT)',
 'CREATE TABLE coordinated_accounts(alias TEXT)', 'CREATE TABLE coordinated_revocations(alias TEXT)', 'CREATE TABLE owner_done(item TEXT)'
])db.exec(ddl);
const proof=conservativePurgeInspector();
assert.equal(proof(sql,'mail'),true);
sql.exec('INSERT INTO coordinated_revocations VALUES (?)','mail');assert.equal(proof(sql,'mail'),false);sql.exec('DELETE FROM coordinated_revocations');
sql.exec('INSERT INTO core_jobs VALUES (?,?)','j',JSON.stringify({mailboxes:[{alias:'mail',identity:'synthetic'}]}));assert.equal(proof(sql,'mail'),false);sql.exec('DELETE FROM core_jobs');
sql.exec('INSERT INTO gen_key_heads VALUES (?)','digest:retained');assert.equal(proof(sql,'mail'),false);sql.exec('DELETE FROM gen_key_heads');
sql.exec('INSERT INTO gen_chunks VALUES (?)','digest:orphan');assert.equal(proof(sql,'mail'),false);sql.exec('DELETE FROM gen_chunks');
sql.exec('INSERT INTO gen_chunks VALUES (?)','cls:other:m1');assert.equal(proof(sql,'mail'),true);
db.exec('CREATE TABLE gen_prepared (value TEXT)');sql.exec('INSERT INTO gen_prepared VALUES (?)','unclassified');assert.equal(proof(sql,'mail'),false);sql.exec('DELETE FROM gen_prepared');
db.exec('CREATE TABLE future_schema (value TEXT)');assert.equal(proof(sql,'mail'),false);db.exec('DROP TABLE future_schema');
assert.equal(proof(sql,'mail'),true);
console.log('Conservative synthetic purge inspector: unknown schema, retained digests, revoked grant, jobs and unclassified artifacts fail closed.');
