import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CachedPage, CatalogDocument, SearchResult } from "./types";

export type IndexDocumentStatus = "indexed" | "failed";
export type SqliteDocumentState = { path: string; status: IndexDocumentStatus; error?: string; sizeBytes: number; mtimeMs: number; fingerprint: string };
export function indexDatabasePath(cacheRoot: string): string { return join(cacheRoot, "search-index.sqlite3"); }
export function normalizeSearchText(text: string): string {
	return text.normalize("NFKC").replace(/([\p{L}\p{N}])-\s*\r?\n\s*([\p{L}\p{N}])/gu, "$1$2").replace(/\s+/g, " ").trim();
}
function openDatabase(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
	const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
	if (version > 1) { db.close(); throw new Error(`Unsupported PDF search index schema version ${version}.`); }
	db.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,title TEXT,size_bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,fingerprint TEXT NOT NULL,page_count INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('indexed','failed')),error TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,pdf_page INTEGER NOT NULL,original_text TEXT NOT NULL,quality TEXT,ocr INTEGER NOT NULL DEFAULT 0,UNIQUE(document_id,pdf_page));
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(page_id UNINDEXED,searchable_text,tokenize='unicode61 remove_diacritics 2');
CREATE INDEX IF NOT EXISTS pages_document_page ON pages(document_id,pdf_page); PRAGMA user_version=1;`);
	return db;
}
export function replaceSqliteDocument(cacheRoot: string, doc: CatalogDocument, fingerprint: string, pages: CachedPage[]): void {
	const db = openDatabase(indexDatabasePath(cacheRoot));
	try { db.exec("BEGIN IMMEDIATE"); try {
		const path = resolve(doc.path); const existing = db.prepare("SELECT id FROM documents WHERE path=?").get(path) as { id:number }|undefined;
		if (existing) { db.prepare("DELETE FROM pages_fts WHERE page_id IN (SELECT id FROM pages WHERE document_id=?)").run(existing.id); db.prepare("DELETE FROM pages WHERE document_id=?").run(existing.id); db.prepare("UPDATE documents SET title=?,size_bytes=?,mtime_ms=?,fingerprint=?,page_count=?,status='indexed',error=NULL,updated_at=? WHERE id=?").run(doc.title??null,doc.sizeBytes,doc.mtimeMs,fingerprint,doc.pages,new Date().toISOString(),existing.id); }
		else db.prepare("INSERT INTO documents(path,title,size_bytes,mtime_ms,fingerprint,page_count,status,error,updated_at) VALUES(?,?,?,?,?,?,'indexed',NULL,?)").run(path,doc.title??null,doc.sizeBytes,doc.mtimeMs,fingerprint,doc.pages,new Date().toISOString());
		const row=db.prepare("SELECT id FROM documents WHERE path=?").get(path) as {id:number}; const ip=db.prepare("INSERT INTO pages(document_id,pdf_page,original_text,quality,ocr) VALUES(?,?,?,?,?)"); const iff=db.prepare("INSERT INTO pages_fts(page_id,searchable_text) VALUES(?,?)");
		for(const page of pages){const text=page.text??page.layoutText??"";const r=ip.run(row.id,page.page,text,page.quality??null,page.ocr?1:0);iff.run(Number(r.lastInsertRowid),normalizeSearchText(text));}
		db.exec("COMMIT"); } catch(e){db.exec("ROLLBACK");throw e;} } finally {db.close();}
}
export function recordSqliteFailure(cacheRoot:string,path:string,error:string):void { const db=openDatabase(indexDatabasePath(cacheRoot));try{db.prepare(`INSERT INTO documents(path,title,size_bytes,mtime_ms,fingerprint,page_count,status,error,updated_at) VALUES(?,NULL,0,0,'',0,'failed',?,?) ON CONFLICT(path) DO UPDATE SET status='failed',error=excluded.error,updated_at=excluded.updated_at`).run(resolve(path),error.slice(0,4000),new Date().toISOString());}finally{db.close();} }
function withPathTable<T>(db:DatabaseSync,paths:string[],fn:()=>T):T { db.exec("CREATE TEMP TABLE IF NOT EXISTS requested_paths(path TEXT PRIMARY KEY); DELETE FROM requested_paths;");const ins=db.prepare("INSERT OR IGNORE INTO requested_paths(path) VALUES(?)");for(const p of paths)ins.run(resolve(p));return fn(); }
export function sqliteDocumentStates(cacheRoot:string,paths:string[]):Map<string,SqliteDocumentState>{const db=openDatabase(indexDatabasePath(cacheRoot));try{return withPathTable(db,paths,()=>new Map((db.prepare("SELECT d.path,d.status,d.error,d.size_bytes sizeBytes,d.mtime_ms mtimeMs,d.fingerprint FROM documents d JOIN requested_paths r ON r.path=d.path").all() as any[]).map(r=>[resolve(r.path),{...r,error:r.error??undefined}])));}finally{db.close();}}
export function sqliteDocumentStatus(cacheRoot:string,path:string):IndexDocumentStatus|undefined{return sqliteDocumentStates(cacheRoot,[path]).get(resolve(path))?.status;}
export function hasFreshSqliteDocument(cacheRoot:string,path:string,sizeBytes:number,mtimeMs:number,fingerprint:string):boolean{const s=sqliteDocumentStates(cacheRoot,[path]).get(resolve(path));return s?.status==="indexed"&&s.sizeBytes===sizeBytes&&s.mtimeMs===mtimeMs&&s.fingerprint===fingerprint;}
function ftsQuery(query:string):string|undefined{const terms=normalizeSearchText(query).match(/[\p{L}\p{N}]+/gu)??[];if(!terms.length)return undefined;return [...new Set(terms)].map(t=>`"${t.replaceAll('"','""')}"`).join(" AND ");}
function cropAroundMatch(text:string,query:string,maxLength=2000):string {
	if(text.length<=maxLength)return text;
	const lower=text.toLocaleLowerCase(),needle=query.toLocaleLowerCase();
	const at=lower.indexOf(needle);
	if(at<0)return text.slice(0,maxLength);
	const start=Math.max(0,Math.min(at-Math.floor((maxLength-needle.length)/2),text.length-maxLength));
	return `${start>0?"…":""}${text.slice(start,start+maxLength-(start>0?1:0)-(start+maxLength<text.length?1:0))}${start+maxLength<text.length?"…":""}`;
}
function originalSnippet(text:string,query:string,contextLines:number):string { const normalized=normalizeSearchText(text),needle=normalizeSearchText(query),lower=normalized.toLocaleLowerCase(),at=lower.indexOf(needle.toLocaleLowerCase());if(at<0)return "";const lines=text.split(/\r?\n/);let startLine=0,endLine=lines.length-1,pos=0;for(let i=0;i<lines.length;i++){const next=normalizeSearchText(lines.slice(0,i+1).join("\n")).length;if(pos<=at&&at<=next)startLine=i;if(pos<=at+needle.length&&at+needle.length<=next){endLine=i;break;}pos=next;}const excerpt=lines.slice(Math.max(0,startLine-contextLines),Math.min(lines.length,endLine+contextLines+1)).map(l=>l.trim()).filter(Boolean).join("\n");return cropAroundMatch(excerpt,query); }
export function searchSqliteIndex(cacheRoot:string,query:string,paths:string[],maxResults:number,contextLines:number):{results:SearchResult[];indexedPaths:Set<string>;failed:Array<{path:string;error:string}>;representable:boolean}{const db=openDatabase(indexDatabasePath(cacheRoot));try{return withPathTable(db,paths,()=>{const docs=db.prepare("SELECT d.path,d.status,d.error FROM documents d JOIN requested_paths r ON r.path=d.path").all() as Array<{path:string;status:string;error:string|null}>;const indexedPaths=new Set(docs.filter(d=>d.status==="indexed").map(d=>resolve(d.path)));const failed=docs.filter(d=>d.status==="failed").map(d=>({path:d.path,error:d.error??"indexing failed"}));const match=ftsQuery(query);if(!match||!indexedPaths.size)return{results:[],indexedPaths,failed,representable:Boolean(match)};const statement=db.prepare(`SELECT d.path,d.title,p.pdf_page,p.original_text,bm25(pages_fts) rank FROM pages_fts JOIN pages p ON p.id=pages_fts.page_id JOIN documents d ON d.id=p.document_id JOIN requested_paths r ON r.path=d.path WHERE pages_fts MATCH ? AND d.status='indexed' ORDER BY rank ASC,d.path,p.pdf_page LIMIT ? OFFSET ?`);const needle=normalizeSearchText(query).toLocaleLowerCase();const results:SearchResult[]=[];const batchSize=Math.max(maxResults*20,100);let offset=0;while(results.length<maxResults){const rows=statement.all(match,batchSize,offset) as any[];for(const row of rows){if(!normalizeSearchText(row.original_text).toLocaleLowerCase().includes(needle))continue;const snippet=originalSnippet(row.original_text,query,contextLines);if(!snippet)continue;results.push({path:row.path,title:row.title??undefined,page:row.pdf_page,snippet,score:-row.rank});if(results.length>=maxResults)break;}if(rows.length<batchSize)break;offset+=rows.length;}return{results,indexedPaths,failed,representable:true};});}finally{db.close();}}
