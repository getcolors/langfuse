import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import {read_deployment,finalize_backend} from "colors-compute-red";
import * as topology from "./topology.ts";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as storage from "./storage.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider, "provider-dns": "cloudflare",
  "provider-backend": "r2", "compute-prevent-destroy": true,
  workdir: ".colors",
};

export const stateEvents=['delete','rehearse','describe'];
export async function startStep(original:Opts,env:Record<string,string|undefined>=process.env,deps:any={}):Promise<Opts>{
 return preflight(original,{defaults,overlay:readPars,validators:[
  (_o,e)=>validate.envErrors(e),
  o=>validate.stateErrors(o),
  (o,_e,c)=>c.real&&['create','delete'].includes(c.event??'')&&!validate.stateErrors(o).length?validate.secretErrors(o,c.event??''):[],
  (o,_e,c)=>c.real&&c.event==='delete'&&o['compute-prevent-destroy']?['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false to delete']:[]],
  afterValidate:async(opts,_env,c)=>{
   if(c.real&&stateEvents.includes(c.event??'')){
    const result:any=await (deps.readDeployment??read_deployment)(opts,{...env,...storage.awsEnv(opts)},undefined,topology.requirements(opts));
    if(c.event==='delete'&&opts['s3-bucket-mode']==='managed'&&result.status!=='present')return {...opts,'langfuse/finalize-only':true,'red/exit':0};
    if(result.status==='destroyed'&&c.event==='delete')return {...opts,'langfuse/already-destroyed':true,'red/exit':0};
    if(result.status!=='present')return {...opts,'red/exit':1,'red/err':'compute state unavailable; legacy monolithic state requires explicit migration'};
    const ready={...opts,'colors-compute/cluster':result.cluster,'colors-compute/shared':result.shared??{},...(result.key?.private_key_path?{'ssh-private-key-path':result.key.private_key_path}:{}),'red/exit':0};
    return c.event==='rehearse'&&storage.managed(opts)?await storage.readCredentials(ready):ready;
   }
   if(c.real&&c.event==='create')return sshConfig.preflight(opts);
   return {...ssh.withMachineKey(opts),'red/exit':0};
  }},env);
}

export async function backendFinalizeStep(opts:Opts):Promise<Opts>{
 try{const result=await finalize_backend(opts,{...process.env,...storage.awsEnv(opts)});if(!['destroyed','absent','skipped'].includes(result.status))throw Error();return {...opts,'red/exit':0};}
 catch{return {...opts,'red/exit':1,'red/err':'managed backend finalization refused; live or unowned state remains'};}
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  switch (runOpts["red/event"]) {
    case "delete": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/ansible"],
        "langfuse/ansible": [tools.ansibleStep, "langfuse/ssh-config"],
        // The `~/.ssh/config` block goes before the destroy, the opposite of
        // the keypair below. A block that outlives its hosts is stale but
        // harmless; a key that predeceases them locks the operator out of
        // machines that still exist. Both orders are deliberate; see
        // standards/ssh-config.md.
        "langfuse/ssh-config": [tools.ansibleLocalStep, "langfuse/dns"],
        // DNS before the compute destroy: a record pointing at a released
        // address is worse than no record.
        "langfuse/dns": [tools.dnsStep, storage.managed(runOpts)?"langfuse/storage":"langfuse/infrastructure"],
        "langfuse/storage": [storage.storageStep,"langfuse/infrastructure"],
        "langfuse/infrastructure": runOpts["s3-bucket-mode"]==="managed"?[tools.infrastructureStep,"langfuse/backend-finalize"]:[tools.infrastructureStep],
        "langfuse/backend-finalize": [backendFinalizeStep],
      };
      return graph[step];
    }
    case "rehearse": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/rehearsal"],
        "langfuse/rehearsal": [tools.rehearsalStep],
      };
      return graph[step];
    }
    case "describe": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/describe"],
        "langfuse/describe": [tools.describeStep],
      };
      return graph[step];
    }
    default: {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/infrastructure"],
        // After compute, which is where the addresses first exist, and before
        // the stage that converges the machines — the converge and the
        // acceptance both ride the aliases this stage writes.
        "langfuse/infrastructure": [tools.infrastructureStep,storage.managed(runOpts)?"langfuse/storage":"langfuse/dns"],
        "langfuse/storage": [storage.storageStep,"langfuse/dns"],
        // DNS before the converge: Caddy provisions its certificate over ACME
        // on first start, and the HTTP-01 challenge needs the name to already
        // resolve to the app host.
        "langfuse/dns": [tools.dnsStep, "langfuse/ssh-config"],
        "langfuse/ssh-config": [tools.ansibleLocalStep, "langfuse/ansible"],
        "langfuse/ansible": [tools.ansibleStep, "langfuse/acceptance"],
        "langfuse/acceptance": [tools.acceptanceStep],
      };
      return graph[step];
    }
  }
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "langfuse/backend-finalize", "langfuse/storage",
  "langfuse/infrastructure", "langfuse/dns", "langfuse/ssh-config",
  "langfuse/ansible", "langfuse/acceptance", "langfuse/ssh-cleanup",
  "langfuse/rehearsal", "langfuse/describe",
];

function create() {
  let wf = workflow({ start: "langfuse/start", wireFn, nextFn:(step,successors,opts)=>opts["langfuse/already-destroyed"]||failed(opts)?[]:step==="langfuse/start"&&opts["langfuse/finalize-only"]?[["langfuse/backend-finalize",opts]]:(successors??[]).map(step=>[step,opts]) });
  wf = adviceAdd(wf, "langfuse/dns", "before", "langfuse.workflow/backend",
    backendAdvice(tools.dnsTool));
  wf = adviceAdd(wf,"langfuse/storage","before","langfuse.workflow/storage-backend",backendAdvice(storage.tool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const langfuseWorkflow = create();
