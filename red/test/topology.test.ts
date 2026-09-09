import {expect,test} from 'bun:test';
import * as t from '../src/topology.ts';
import {base,params} from './support.ts';
import {plan_deployment} from 'colors-compute-red';
const opts={...base,'red/event':'build'};
test('six machines in four roles with app entry',()=>{
 const hs=t.hosts(opts);expect(hs.map(h=>h.node_id)).toEqual(['neon-0','redis-0','clickhouse-0','clickhouse-1','clickhouse-2','app-0']);
 expect(t.requirements(opts).entry_node_id).toBe('app-0');
 expect(hs.map(h=>h.index)).toEqual([null,null,0,1,2,null]);
 const plan:any=plan_deployment(opts,t.topology(opts),t.requirements(opts));expect(plan.cluster.entry_node_id).toBe('app-0');
});
test('observed state preserves metadata and names',()=>{
 const recorded={...params,nodes:params.nodes.map((n:any)=>({...n,name:'observed-'+n.node_id,extra:'kept'}))};
 const hs=t.hosts(opts,recorded);expect(t.hostOf(hs,'app')?.name).toBe('observed-app-0');expect(hs[0]?.extra).toBe('kept');expect(hs[0]?.['vpc-ip']).toBe('10.50.0.2');
});
test('partial or nonprivate joins are refused',()=>{
 expect(()=>t.hosts(opts,{...params,nodes:params.nodes.slice(1)})).toThrow();
 expect(()=>t.hosts(opts,{...params,nodes:params.nodes.map((n:any)=>({...n,vpc_ip:null}))})).toThrow();
});
