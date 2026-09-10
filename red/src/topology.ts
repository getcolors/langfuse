import type {Opts} from 'red/workflow';
import {collect,expand,plan_deployment,source_cidrs} from 'colors-compute-red';
import {cloudflareRangesFallback} from './cloudflare-ranges.ts';
export const defaultComputeProvider='vultr';
export const clickhouseNodeCount=3;
export type Role='neon'|'redis'|'clickhouse'|'app';
export const roles:Role[]=['neon','redis','clickhouse','app'];
export const topology=(_opts:Opts)=>roles.map(role=>({role,count:role==='clickhouse'?3:1}));
export interface Host {role:string;index:number|null;node_id:string;name:string;ip:string;'vpc-ip':string;user:string;sudoer:string;[extra:string]:any}
export function requirements(opts:Opts,httpRanges?:string[]):any {
 if(httpRanges===undefined){const sources=source_cidrs(opts,'http-sources','langfuse-http-sources');httpRanges=sources.length===1&&sources[0]==='cloudflare'?(opts['provider-compute']==='aws'?cloudflareRangesFallback.filter(cidr=>!cidr.includes(':')):cloudflareRangesFallback):sources;}
 const ssh={id:'ssh',protocol:'tcp',from_port:22,to_port:22,sources:source_cidrs(opts,'ssh-sources','langfuse-ssh-sources')};
 const peer=(id:string,port:number,peer_roles:string[])=>({id,protocol:'tcp',from_port:port,to_port:port,peer_roles});
 const policy=(rules:any[])=>({ingress:[ssh,...rules],egress:'all',private_filter:true});
 return {private:true,entry_node_id:'app-0',legacy_state_keys:[opts.profile+'/langfuse-infrastructure.tfstate'],security:policy([]),roles:{
  neon:{security:policy([peer('postgres',neonComputePort,['app'])])},
  redis:{security:policy([peer('redis',redisPort(opts),['app'])])},
  clickhouse:{security:policy([...appClickhousePorts(opts).map(p=>peer('app-'+p,p,['app'])),...clickhouseInternalPorts(opts).map(p=>peer('replica-'+p,p,['clickhouse']))])},
  app:{security:policy([80,443].map(p=>({id:'http-'+p,protocol:'tcp',from_port:p,to_port:p,sources:httpRanges})))}}};
}
const asHost=(node:any):Host=>{const {vpc_ip,...rest}=node;return {...rest,'vpc-ip':vpc_ip,index:node.role==='clickhouse'?node.index:null};};
export function hosts(opts:Opts,params?:any):Host[]{
 let cluster=params??opts['colors-compute/cluster'];
 if(!cluster){if(opts['red/event']!=='build'&&!opts['red/dry-run'])throw Error('compute cluster unavailable');cluster=plan_deployment(opts,topology(opts),requirements(opts)).cluster;}
 return collect(expand(topology(opts)).map(n=>({...n,private:true})),cluster.nodes,'app-0').nodes.map(asHost);
}
export const fallbackHosts=(opts:Opts)=>hosts({...opts,'red/event':'build'});
export const hostOf=(list:Host[],role:string,i?:number)=>list.find(h=>h.role===role&&h.index===(i??null));
export const clickhouseHosts=(list:Host[])=>list.filter(h=>h.role==='clickhouse').sort((a,b)=>a.index!-b.index!);

export function port(opts: Opts, key: string, fallback: number): number {
  const value = opts[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

export const clickhouseHttpPort = (opts: Opts) => port(opts, "clickhouse-http-port", 8123);
export const clickhouseNativePort = (opts: Opts) => port(opts, "clickhouse-native-port", 9000);
export const clickhouseInterserverPort = (opts: Opts) => port(opts, "clickhouse-interserver-port", 9009);
export const clickhouseKeeperPort = (opts: Opts) => port(opts, "clickhouse-keeper-port", 9181);
export const clickhouseRaftPort = (opts: Opts) => port(opts, "clickhouse-raft-port", 9234);
export const redisPort = (opts: Opts) => port(opts, "redis-port", 6379);
export const neonComputePort = 55433;

// What the three replicas need from each other: the native port for
// distributed queries and `clusterAllReplicas`, interserver for part
// exchange, the Keeper client port, and raft.
export function clickhouseInternalPorts(opts: Opts): number[] {
  return [clickhouseNativePort(opts), clickhouseInterserverPort(opts),
    clickhouseKeeperPort(opts), clickhouseRaftPort(opts)];
}

// What the app host needs from ClickHouse: HTTP for queries, native for the
// migration runner. Never Keeper, never raft.
export function appClickhousePorts(opts: Opts): number[] {
  return [clickhouseHttpPort(opts), clickhouseNativePort(opts)];
}
