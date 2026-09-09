from conftest import fixture, PARAMS
from colors_compute.planning import plan_deployment
from package_langfuse_blue import topology


def test_six_roles_and_app_entry_preserve_application_shape():
    opts = fixture({'blue/event': 'build'})
    roles = topology.topology(opts)
    assert roles == [{'role': 'neon', 'count': 1}, {'role': 'redis', 'count': 1}, {'role': 'clickhouse', 'count': 3}, {'role': 'app', 'count': 1}]
    result = plan_deployment(opts, roles, topology.requirements(opts))
    assert result['cluster']['entry_node_id'] == 'app-0'
    hosts = topology.hosts({**opts, 'colors-compute/cluster': result['cluster']})
    assert [h['index'] for h in hosts] == [None, None, 0, 1, 2, None]
    assert topology.host_of(hosts, 'app')['node_id'] == 'app-0'


def test_library_owns_names_plans_and_exact_peer_rules():
    opts = fixture({'blue/event': 'build', 'vultr-name': 'custom'})
    result = plan_deployment(opts, topology.topology(opts), topology.requirements(opts))
    assert result['cluster']['nodes'][0]['name'] == 'custom-neon-0'
    for node in result['cluster']['nodes']:
        resource = result['documents']['nodes'][node['node_id']]['node.tf.json']['resource']['vultr_instance']['node']
        assert resource['plan'] == opts['vultr-plan-' + node['role']]
    rules = result['documents']['shared']['shared-roles.tf.json']['locals']['ingress']
    peer_rules = {key: value for key, value in rules.items() if ':peer:' in key}
    assert all(value['subnet_size'] == 32 for value in peer_rules.values())
    assert not any(':peer:redis-' in key or ':peer:neon-' in key for key in peer_rules)
    assert len(peer_rules) == 16


def test_recorded_metadata_never_becomes_placeholder_addresses():
    hosts = topology.hosts({'colors-compute/cluster': PARAMS})
    assert hosts[0]['vpc-ip'] == '10.50.0.2'
    assert hosts[0]['name'] == 'langfuse-test-neon'
