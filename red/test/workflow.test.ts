import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as w from '../src/workflow.ts';
import * as tools from '../src/tools.ts';
import {base} from './support.ts';
function chain(event:string){const out:string[]=[];let step='langfuse/start';for(;;){out.push(step);const next=w.wireFn(step,{'red/event':event})?.[1];if(!next)return out;step=String(next);}}
test('application ordering surrounds library compute lifecycle',()=>{
 expect(chain('create')).toEqual(['langfuse/start','langfuse/infrastructure','langfuse/dns','langfuse/ssh-config','langfuse/ansible','langfuse/acceptance']);
 expect(chain('delete')).toEqual(['langfuse/start','langfuse/ansible','langfuse/ssh-config','langfuse/dns','langfuse/infrastructure']);
});
test('planning emits split compute documents without credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'langfuse-red-'));try{const r=await tools.infrastructureStep({...base,workdir:dir,'red/event':'build'});expect(r['red/exit']).toBe(0);expect(r['colors-compute/cluster'].nodes.length).toBe(6);expect(existsSync(join(dir,base.profile,'compute','shared'))).toBe(true);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('safe lifecycle diagnostics survive the application adapter',async()=>{
 const r=await tools.infrastructureStep({...base,'red/event':'create'},{httpSources:async()=>({source:'explicit',ranges:['0.0.0.0/0']}),orchestrate:async()=>({status:'error',errors:['missing COLORS_PAR_VULTR_API_KEY']})});expect(r['red/exit']).toBe(1);expect(r['red/err']).toBe('missing COLORS_PAR_VULTR_API_KEY');
});
test('unavailable fresh Cloudflare sources refuse before compute',async()=>{
 let calls=0;const r=await tools.infrastructureStep({...base,'red/event':'create'},{httpSources:async()=>({source:'fallback',ranges:[]}),orchestrate:async()=>{calls++;}});expect(r['red/exit']).toBe(1);expect(calls).toBe(0);
});
test('missing managed deployment refuses state-dependent application work',async()=>{
 const r=await w.startStep({...base,'red/event':'describe'},{},{readDeployment:async()=>({status:'absent'})});expect(r['red/exit']).toBe(1);expect(r['red/err']).toContain('compute state unavailable');
});

test('native workflow builds all application artifacts in managed and external modes',async()=>{
 const {run}=await import('red/workflow');
 for(const external of [false,true]){const dir=mkdtempSync(join(tmpdir(),'langfuse-native-'));try{
 const opts={...base,workdir:dir,'red/event':'build',...(external?{'vultr-ssh-keys':['owned-key'],'ssh-private-key-path':'/tmp/operator-key'}:{})};
 const result=await run(w.langfuseWorkflow,opts);expect(result['red/exit']).toBe(0);
 expect(existsSync(join(dir,base.profile,'langfuse-ansible','site.yml'))).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}}
});
