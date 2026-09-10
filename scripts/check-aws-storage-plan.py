#!/usr/bin/env python3
"""Inspect the managed AWS fixture's rendered contract without provider calls."""
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
profile = "langfuse-aws-fixture"
plan = root / profile
expected = {"neon-0": "t3.xlarge", "redis-0": "t3.small", "app-0": "t3.xlarge",
            **{f"clickhouse-{n}": "t3.xlarge" for n in range(3)}}
nodes = list((plan / "compute/nodes").glob("*/node.tf.json"))
assert {path.parent.name for path in nodes} == set(expected), "all six declared AWS nodes must render"
for path in nodes:
    document = json.loads(path.read_text())
    machine = document["resource"]["aws_instance"]["node"]
    assert machine["instance_type"] == expected[path.parent.name]
    assert machine["lifecycle"]["prevent_destroy"] is True
    assert machine["root_block_device"]["encrypted"] is True
    assert document["output"]["params"]["value"]["user"] == "ubuntu"
shared = json.loads((plan / "compute/shared/shared-roles.tf.json").read_text())
assert set(shared["resource"]["aws_security_group"]["role"]["for_each"]) == {"neon", "redis", "clickhouse", "app"}
assert "aws_key_pair" in json.loads((plan / "compute/shared/shared-keygen.tf.json").read_text())["resource"]

storage = (plan / "langfuse-storage/main.tf").read_text()
buckets = dict(re.findall(r'^\s*(neon|data|backup)\s*=\s*"([^"]+)"\s*$', storage, re.MULTILINE))
assert set(buckets) == {"neon", "data", "backup"}
assert len(set(buckets.values())) == 3, "live stores and backups must remain isolated"
backend = json.loads((plan / "langfuse-storage/backend.tf.json").read_text())["terraform"]["backend"]["s3"]
assert backend["bucket"] not in buckets.values()
assert backend["key"] == profile + "/langfuse-storage.tfstate"
assert backend["region"] == "us-east-1"
assert re.search(r'prevent_destroy\s*=\s*true', storage)
assert re.search(r'block_public_policy\s*=\s*true', storage)
assert 'sse_algorithm = "AES256"' in storage
assert 'resource "aws_iam_user" "application"' in storage
assert 'aws_s3_bucket.application[each.key].arn' in storage, "each IAM identity must be scoped to its own bucket"
assert '"s3:*"' not in storage
assert re.search(r'output "credentials"\s*\{[\s\S]*?sensitive\s*=\s*true', storage)
assert 'resource "aws_s3_bucket_cors_configuration" "media"' in storage
assert 'allowed_origins = ["https://langfuse-aws-fixture.example.com"]' in storage

inventory = json.loads((plan / "langfuse-ansible/inventory.json").read_text())["all"]["children"]
assert {role: len(group["hosts"]) for role, group in inventory.items()} == {"neon": 1, "redis": 1, "clickhouse": 3, "app": 1}
assert all(host["ansible_user"] == "ubuntu" for group in inventory.values() for host in group["hosts"].values())
for path in plan.rglob("*"):
    if path.is_file():
        text = path.read_text()
        assert "<{" not in text, f"unrendered package template in {path}"
        assert "PRIVATE KEY-----" not in text, f"private key rendered into {path}"
print("AWS fixture: six role-sized nodes, three private stores, scoped IAM, media CORS, separate S3 state")
