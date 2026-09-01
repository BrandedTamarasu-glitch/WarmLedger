'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Schema=require('../js/data-schema.js'),Engine=require('../js/storage-engine.js');
const {makeV3Budget,MemoryStorage}=require('./helpers.js');
const G='20260901T123456789Z-550e8400-e29b-41d4-a716-446655440000',G2='20260901T123456790Z-550e8400-e29b-41d4-a716-446655440001',AT='2026-09-01T12:34:56.789Z';
const json=v=>JSON.stringify(v),bad=(code,fn)=>assert.throws(fn,e=>e.code===code);

test('generation IDs and immutable generation-addressed key builders are deterministic',()=>{
 assert.equal(Engine.createGenerationId(new Date(AT),'550e8400-e29b-41d4-a716-446655440000'),G);
 assert.equal(Engine.manifestKey(G),`zeroBudget_manifest:${G}`);assert.equal(Engine.globalKey(G),`zeroBudget_global:${G}`);assert.equal(Engine.monthKey(G,'2026-01'),`zeroBudget_month:${G}:2026-01`);
 bad('INVALID_UUID',()=>Engine.createGenerationId(new Date(AT),'no'));bad('INVALID_GENERATION',()=>Engine.buildRootPointer({generation:'bad',residentSchemaVersion:3,committedAt:AT}));
 assert.equal(Engine.sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');assert.equal(Engine.utf8Length('Warm £ 🔥'),12);
});
test('root, manifest and shard codecs enforce exact keys, refs, schemas, months and detachment',()=>{
 const root=Engine.buildRootPointer({generation:G,residentSchemaVersion:3,committedAt:AT});assert.deepEqual(Engine.parseRootPointer(json(root)),root);
 const global=Engine.buildGlobalShard({generation:G,residentSchemaVersion:3,data:{schemaVersion:3,categories:[],settings:{earners:[]},templates:{income:[],expenses:[]}}});
 const parsed=Engine.parseGlobalShard(json(global),G,3);parsed.data.categories.push(1);assert.equal(global.data.categories.length,0);
 const month=Engine.buildMonthShard({generation:G,residentSchemaVersion:3,monthKey:'2026-01',data:{paychecks:[],expenses:[],allocations:{savings:0,credit_card_debt:0,investments:0},suppressedOccurrences:[]}});assert.deepEqual(Engine.parseMonthShard(json(month),G,3,'2026-01'),month);
 const month2=Engine.buildMonthShard({generation:G,residentSchemaVersion:3,monthKey:'2026-02',data:month.data});
 const manifest=Engine.buildManifest({generation:G,residentSchemaVersion:3,committedAt:AT,global:Engine.globalReference(json(global)),monthOrder:['2026-01','2026-02'],months:{'2026-01':Engine.monthReference(json(month)),'2026-02':Engine.monthReference(json(month2))}});assert.deepEqual(Engine.parseManifest(json(manifest),G),manifest);
 const changed=(value,fn)=>{const v=JSON.parse(json(value));fn(v);return v;};
 bad('UNKNOWN_FIELD',()=>Engine.parseRootPointer(json(changed(root,v=>{v.bytes=1;}))));bad('INVALID_KEY_REFERENCE',()=>Engine.parseRootPointer(json(changed(root,v=>{v.manifestKey='x';}))));
 bad('MIXED_GENERATION',()=>Engine.parseManifest(json(changed(manifest,v=>{v.generation=G2;})),G));bad('MONTH_REFERENCE_MISMATCH',()=>Engine.parseManifest(json(changed(manifest,v=>{delete v.months['2026-02'];}))));
 bad('INVALID_KEY_REFERENCE',()=>Engine.parseManifest(json(changed(manifest,v=>{v.months['2026-01'].key='wrong';}))));bad('MIXED_SCHEMA',()=>Engine.parseGlobalShard(json(changed(global,v=>{v.residentSchemaVersion=4;})),G,3));bad('MIXED_MONTH',()=>Engine.parseMonthShard(json(changed(month,v=>{v.monthKey='2026-02';})),G,3,'2026-01'));
 bad('UNSORTED_MONTHS',()=>Engine.buildManifest({...manifest,monthOrder:['2026-02','2026-01']}));bad('DUPLICATE_MONTH',()=>Engine.buildManifest({...manifest,monthOrder:['2026-01','2026-01']}));
});
test('a G2 manifest reuses G1 global and unchanged month while referencing a changed G2 month',()=>{
 const data={paychecks:[],expenses:[],allocations:{savings:0,credit_card_debt:0,investments:0},suppressedOccurrences:[]};
 const global=Engine.buildGlobalShard({generation:G,residentSchemaVersion:3,data:{schemaVersion:3,categories:[],settings:{earners:[]},templates:{income:[],expenses:[]}}}),oldMonth=Engine.buildMonthShard({generation:G,residentSchemaVersion:3,monthKey:'2026-01',data}),newMonth=Engine.buildMonthShard({generation:G2,residentSchemaVersion:3,monthKey:'2026-02',data});
 const gr=Engine.globalReference(json(global)),oldRef=Engine.monthReference(json(oldMonth)),newRef=Engine.monthReference(json(newMonth));
 const manifest=Engine.buildManifest({generation:G2,residentSchemaVersion:3,committedAt:AT,global:gr,monthOrder:['2026-01','2026-02'],months:{'2026-01':oldRef,'2026-02':newRef}});const parsed=Engine.parseManifest(json(manifest),G2);
 assert.equal(parsed.global.generation,G);assert.equal(parsed.months['2026-01'].generation,G);assert.equal(parsed.months['2026-02'].generation,G2);
 assert.deepEqual(Engine.validateGlobalReference(parsed.global,json(global)),global);assert.deepEqual(Engine.validateMonthReference(parsed.months['2026-02'],json(newMonth)),newMonth);
 const wrongKey={...newRef,key:Engine.monthKey(G,'2026-02')};bad('INVALID_KEY_REFERENCE',()=>Engine.buildManifest({...manifest,months:{...manifest.months,'2026-02':wrongKey}}));
 bad('BYTE_LENGTH_MISMATCH',()=>Engine.validateMonthReference({...newRef,byteLength:newRef.byteLength+1},json(newMonth)));bad('SHA256_MISMATCH',()=>Engine.validateMonthReference({...newRef,sha256:'0'.repeat(64)},json(newMonth)));
 const wrongKindRaw=json(newMonth),wrongKindRef={...gr,byteLength:Engine.utf8Length(wrongKindRaw),sha256:Engine.sha256(wrongKindRaw)};bad('UNKNOWN_FIELD',()=>Engine.validateGlobalReference(wrongKindRef,wrongKindRaw));
 const mixedRaw=json({...newMonth,generation:G}),mixedRef={...newRef,byteLength:Engine.utf8Length(mixedRaw),sha256:Engine.sha256(mixedRaw)};bad('MIXED_GENERATION',()=>Engine.validateMonthReference(mixedRef,mixedRaw));
 const monthRaw=json({...newMonth,monthKey:'2026-01'}),monthRef={...newRef,byteLength:Engine.utf8Length(monthRaw),sha256:Engine.sha256(monthRaw)};bad('MIXED_MONTH',()=>Engine.validateMonthReference(monthRef,monthRaw));
});
test('journals validate transitions and reject duplicate, mixed and malformed references',()=>{
 const stagedKeys=[Engine.monthKey(G,'2026-01'),Engine.manifestKey(G)],j=Engine.buildJournal({txId:G,baseMode:'legacy',baseGeneration:null,nextGeneration:G,residentSchemaVersion:3,stagedKeys,startedAt:AT,expiresAt:100});assert.deepEqual(Engine.parseJournal(json(j)),j);
 bad('INVALID_BASE_GENERATION',()=>Engine.buildJournal({txId:G,baseMode:'sharded',baseGeneration:null,nextGeneration:G,residentSchemaVersion:3,stagedKeys:[],startedAt:AT,expiresAt:1}));
 const mixed={...j,txId:G2};bad('MIXED_GENERATION',()=>Engine.parseJournal(json(mixed)));const duplicate={...j,stagedKeys:[j.stagedKeys[0],j.stagedKeys[0]]};bad('DUPLICATE_KEY',()=>Engine.parseJournal(json(duplicate)));bad('INVALID_KEY_REFERENCE',()=>Engine.buildJournal({...j,stagedKeys:[Engine.globalKey(G2)]}));
});
test('fragment split and assembly round trip resident schemas 3 through 7 including null and entered zero',()=>{
 const v3=makeV3Budget();v3.months['2026-01'].expenses[0].actualAmount=null;v3.months['2026-01'].paychecks[0].actualAmount=0;
 const v4=Schema.migrateV3ToV4ExactMoney(v3),v5=Schema.migrateV4ToV5(v4),v6=Schema.migrateV5ToV6(v5),v7=Schema.migrateV6ToV7(v6);
 const versions=[v3,v4,v5,v6,v7];
 for(const runtime of versions){const version=runtime.schemaVersion,parts=Schema.buildShardedFragments(runtime,version);assert.deepEqual(parts.monthOrder,['2026-01']);const assembled=Schema.assembleShardedActiveData(parts.global,parts.months,version);assert.equal(assembled.months['2026-01'].expenses[0].actualAmount,null);assert.equal(assembled.months['2026-01'].paychecks[0].actualAmount,0);Schema.validateGlobalFragment(parts.global,version);Schema.validateMonthFragment(parts.global,'2026-01',parts.months['2026-01'],version);}
 const parts=Schema.buildShardedFragments(v3,3);const extra={...parts.months['2026-01'],bytes:1};bad('UNKNOWN_FIELD',()=>Schema.validateMonthFragment(parts.global,'2026-01',extra,3));bad('UNSUPPORTED_SCHEMA_VERSION',()=>Schema.validateGlobalFragment({...parts.global,schemaVersion:4},3));
});
test('legacy coordinator stays byte-exact while separate sharded coordinator renews expanded locks',()=>{
 const storage=new MemoryStorage(),clock={value:0},now=()=>new Date(clock.value),legacy=Engine.createCoordinator({storage,now,ownerId:'legacy'});assert.deepEqual(legacy.acquire(),{ownerId:'legacy',expiresAt:5000});assert.equal(storage.getItem(Engine.WRITE_LOCK_KEY),'{"ownerId":"legacy","expiresAt":5000}');legacy.release();
 const a=Engine.createShardedCoordinator({storage,now,ownerId:'a'}),b=Engine.createShardedCoordinator({storage,now,ownerId:'b'}),lock=a.acquire();assert.deepEqual(lock,{ownerId:'a',revision:'legacy',heartbeatAt:0,expiresAt:8000});bad('STORE_BUSY',()=>b.acquire());clock.value=2499;assert.equal(a.shouldRenew(lock),false);clock.value=2500;assert.equal(a.shouldRenew(lock),true);assert.equal(a.renew().expiresAt,10500);clock.value=10500;bad('STORE_BUSY',()=>a.renew());assert.equal(b.acquire().ownerId,'b');assert.equal(a.release(),true);assert.equal(storage.getItem(Engine.WRITE_LOCK_KEY)!==null,true);assert.equal(b.release(),true);assert.equal(storage.getItem(Engine.WRITE_LOCK_KEY),null);
});
