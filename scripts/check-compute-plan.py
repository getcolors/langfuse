"""Validate the deployment's library-owned state boundaries in offline builds."""
import json
import sys
from pathlib import Path
root, variant = Path(sys.argv[1]), sys.argv[2]
shared = json.loads((root / 'shared/shared-roles.tf.json').read_text())
resources = shared['resource']
assert 'vultr_instance' not in resources
peers = {key: value for key, value in shared['locals']['ingress'].items() if ':peer:' in key}
assert len(peers) == 16
assert all(rule['subnet_size'] == 32 for rule in peers.values())
assert len(resources['vultr_firewall_group']['role']['for_each']) == 4
assert (root / 'shared/shared-keygen.tf.json').exists() == (variant == 'colors')
expected = {'neon-0', 'redis-0', 'clickhouse-0', 'clickhouse-1', 'clickhouse-2', 'app-0'}
assert {p.name for p in (root / 'nodes').iterdir()} == expected
for node_id in expected:
    document = json.loads((root / 'nodes' / node_id / 'node.tf.json').read_text())
    assert set(document['resource']) == {'vultr_instance'}
    assert set(document['resource']['vultr_instance']) == {'node'}
    assert document['resource']['vultr_instance']['node']['lifecycle']['prevent_destroy'] is True
