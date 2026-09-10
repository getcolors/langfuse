import {afterEach, expect, spyOn, test} from "bun:test";
import * as tofu from "red/tofu";
import {runtime} from "red/runtime";
import * as storage from "../src/storage.ts";
let mocked: ReturnType<typeof spyOn> | undefined;
afterEach(() => mocked?.mockRestore());
const opts = {profile:"owned",workdir:"/tmp", "langfuse-storage-managed":true,"neon-r2-bucket":"owned-neon", "langfuse-s3-bucket":"owned-data", "langfuse-backup-r2-bucket":"owned-backup", "neon-r2-region":"us-east-1"};
test("managed storage refuses existing or inaccessible untracked buckets", async () => {
  for (const probe of [{exit:0,out:"",err:""},{exit:1,out:"",err:"(403) Forbidden"}]) {
    mocked = spyOn(runtime,"exec").mockResolvedValueOnce({exit:0,out:"",err:""}).mockResolvedValueOnce({exit:0,out:"",err:""}).mockResolvedValue(probe);
    await expect(storage.ownershipPreflight(opts)).rejects.toThrow("refuses to adopt");
    mocked.mockRestore();
  }
});
test("fresh remote state probes three application buckets", async () => {
  mocked = spyOn(runtime,"exec").mockResolvedValueOnce({exit:0,out:"",err:""}).mockResolvedValueOnce({exit:1,out:"",err:"No state file was found!"}).mockResolvedValue({exit:1,out:"",err:"(404) Not Found"});
  await storage.ownershipPreflight(opts);
  expect(mocked).toHaveBeenCalledTimes(5);
});
test("renaming a tracked bucket refuses adoption of an existing destination", async () => {
  mocked = spyOn(runtime,"exec").mockResolvedValueOnce({exit:0,out:"",err:""}).mockResolvedValueOnce({exit:0,out:'aws_s3_bucket.application["neon"]',err:""}).mockResolvedValueOnce({exit:0,out:JSON.stringify({values:{root_module:{resources:[{address:'aws_s3_bucket.application["neon"]',values:{bucket:"old-neon"}}]}}}),err:""}).mockResolvedValue({exit:0,out:"",err:""});
  await expect(storage.ownershipPreflight(opts)).rejects.toThrow("refuses to adopt");
});
test("each role receives a distinct scoped environment pair", () => {
  const credentials = {credentials:Object.fromEntries(["neon","data","backup"].map(role=>[role,{access_key_id:role+"-id",secret_access_key:role+"-secret"}]))};
  const env = storage.credentialEnv({...opts,"langfuse/storage-credentials":credentials});
  expect(env.COLORS_PAR_NEON_R2_ACCESS_KEY_ID).toBe("neon-id");
  expect(env.COLORS_PAR_LANGFUSE_STORAGE_R2_ACCESS_KEY_ID).toBe("data-id");
  expect(env.COLORS_PAR_LANGFUSE_BACKUP_R2_ACCESS_KEY_ID).toBe("backup-id");
  expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(()=>storage.credentialEnv(opts)).toThrow("unavailable");
});

test("sensitive tofu JSON decodes into three scoped Ansible credential pairs", async () => {
  const value = Object.fromEntries(["neon","data","backup"].map(role => [role,{access_key_id:role+"-id",secret_access_key:role+"-secret"}]));
  mocked = spyOn(runtime,"exec").mockResolvedValue({exit:0,out:JSON.stringify({credentials:{sensitive:true,type:["object",{}],value}}),err:""});
  const decoded = await tofu.outputs("/unused");
  const env = storage.credentialEnv({...opts,"langfuse/storage-credentials":decoded});
  expect(env.COLORS_PAR_NEON_R2_ACCESS_KEY_ID).toBe("neon-id");
  expect(env.COLORS_PAR_LANGFUSE_STORAGE_R2_SECRET_ACCESS_KEY).toBe("data-secret");
  expect(env.COLORS_PAR_LANGFUSE_BACKUP_R2_SECRET_ACCESS_KEY).toBe("backup-secret");
  expect(mocked.mock.calls[0]![0]).toEqual(["tofu","output","-json"]);
});
