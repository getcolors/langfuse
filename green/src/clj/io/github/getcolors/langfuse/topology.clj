(ns io.github.getcolors.langfuse.topology
  "Everything that turns desired state into the six machines and their
  addresses.

  Six machines carry far more derived identity than one: a ClickHouse
  replica that names a peer wrongly forms no quorum, an app host that points
  at a stale VPC address fails only after the migration timeout, and a
  firewall rule sourced from the wrong `/32` is a silent denial.

  The node set itself — the six ids, the fallback addresses a `build`
  renders with, the aliases, and the refusal of a state that does not
  describe every machine — is the Compute Cluster Standard's
  (`workspace/standards/compute-cluster.md`) and is ONCE's `compute-cluster`
  namespace, called with the `spec` below and never copied. What stays here
  is Langfuse's: the roles and their fixed counts, the per-role plan key,
  the host lookups the plays and the DNS stage use, and the ports. Everything
  here is a pure function of desired state plus the compute stage's output,
  so the whole of it is reachable from the test suite and visible in the
  goldens. Nothing in this file may read the environment, the filesystem,
  or the network."
  (:require [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as once-cluster]))

;; ---------------------------------------------------------------- the spec

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are the non-secret keys the provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, `:tofu-env` the
  subset OpenTofu reads from the process environment itself, and `:network`
  the private network every database connection crosses — created by this
  package from `vultr-vpc-subnet`, never discovered. Keeping them together is
  what stops a provider being validated against one set of keys and run with
  another. The keys of this map are the advertised providers; Vultr is the
  only one this package has a template and a golden for.

  Two keys the template reads are deliberately not required. `vultr-name` is
  an optional override of the profile (Compute Name Standard), and
  `vultr-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
  `vultr-http-sources` is required but deliberately NOT one of the spec's
  `:sources`: it accepts the symbolic value `cloudflare`, which the package
  resolves itself (see `tools/http-sources`)."
  {"vultr"
   {:required [:vultr-region :vultr-os-id :vultr-vpc-subnet
               :vultr-plan-neon :vultr-plan-redis :vultr-plan-clickhouse :vultr-plan-app
               :vultr-ssh-sources :vultr-http-sources]
    :secrets [:vultr-api-key]
    :tofu-env {:vultr-api-key "VULTR_API_KEY"}
    :network {:mode :created :key :vultr-vpc-subnet}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered."
  "vultr")

(def clickhouse-node-count 3)

(def spec
  "How this package describes itself to ONCE's `compute-cluster`. Four roles
  in play order — `app` last because it is the consumer of the other three —
  with fixed counts: one shard of three ClickHouse replicas, and one machine
  each for the storage tier, the cache and the application. The bare
  `<profile>` alias reaches the app host, the machine an operator most often
  means. The fallback offsets are where each role's placeholder landed inside
  the subnet before adoption, so the committed goldens carry the same
  addresses: 10, 11, 12 for the singletons and 20-22 for the replicas."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources"] :may-be-empty []}
   :roles [{:role "neon" :count 1 :fallback-offset 10}
           {:role "redis" :count 1 :fallback-offset 11}
           {:role "clickhouse" :count clickhouse-node-count :fallback-offset 20}
           {:role "app" :count 1 :fallback-offset 12}]
   :entry {:role "app" :index 0}})

(def roles
  "The roles in play order, as keywords."
  (mapv (comp keyword :role) (:roles spec)))

(defn compute-name
  "The deployment's base machine name (Compute Name Standard §1-2): the
  profile, unless desired state overrides it with `vultr-name`. ONCE's, so
  every label derives from the same value."
  [opts]
  (compute/name opts))

(defn machine-name
  "The label of a machine: `<name>-<role>` for the singletons and
  `<name>-clickhouse-<i>` for the replicas — the Cluster Standard's fallback
  name, which is also what the template labels the instance."
  ([opts role] (machine-name opts role 0))
  ([opts role i] (once-cluster/fallback-node-name spec opts {:role (name role) :index i})))

(defn plan-key [role] (keyword (str "vultr-plan-" (name role))))

;; --------------------------------------------------------------------- hosts

(defn- singleton-role?
  "Whether `role` (a string) is declared with a count of one."
  [role]
  (= 1 (once-cluster/node-count spec {} role)))

(defn- langfuse-host
  "One of ONCE's nodes as this package's renderers read it. Two respellings,
  both at this boundary so every rendered file stays byte-identical: ONCE
  records `:vpc_ip` with the underscore where the templates, the inventory
  and the firewall data were written against `:vpc-ip`; and ONCE gives every
  node an index (a singleton's is 0) where the inventory writes an `ordinal`
  only for the replicas, so a singleton's index reads as nil here. Nothing
  else is touched: the name is the label the template gave the instance,
  never recomputed, and extension fields ride through."
  [node]
  (cond-> (-> node (dissoc :vpc_ip) (assoc :vpc-ip (:vpc_ip node)))
    (singleton-role? (:role node)) (assoc :index nil)))

(defn fallback-hosts
  "What a credential-free `build` renders in place of a compute output:
  ONCE's fallbacks — public addresses from `192.0.2.0/24`, private ones cut
  from `vultr-vpc-subnet`, each at its role's offset — so a build is
  byte-identical on every workstation and the committed goldens mean
  something."
  [opts]
  (mapv langfuse-host (once-cluster/fallback-nodes spec opts)))

(defn hosts
  "The host list the Ansible stage, the DNS stage and the acceptance consume.

  `params` is the compute stage's recorded `params` map, adopted under
  `:once/cluster` on a real run. On a build there is none, so the fallbacks
  stand in. On a real run ONCE refuses a state that does not describe every
  declared machine with every field, and never substitutes a fallback: a
  ClickHouse cluster config naming fewer replicas than exist forms no quorum,
  and an app environment pointing at a missing address fails only after the
  migration timeout."
  ([opts] (hosts opts (:once/cluster opts)))
  ([opts params] (mapv langfuse-host (once-cluster/nodes spec opts params))))

(defn host-of
  "The single host for `role`, or the `i`th ClickHouse node."
  ([hosts* role] (first (filter #(and (= (name role) (:role %)) (nil? (:index %))) hosts*)))
  ([hosts* role i] (first (filter #(and (= (name role) (:role %)) (= i (:index %))) hosts*))))

(defn clickhouse-hosts [hosts*]
  (->> hosts* (filter #(= "clickhouse" (:role %))) (sort-by :index) vec))

;; --------------------------------------------------------------------- ports

(defn port [opts k default]
  (let [v (get opts k)]
    (cond (integer? v) v
          (and (string? v) (re-matches #"^\d+$" v)) (Long/parseLong v)
          :else default)))

(defn clickhouse-http-port [opts] (port opts :clickhouse-http-port 8123))
(defn clickhouse-native-port [opts] (port opts :clickhouse-native-port 9000))
(defn clickhouse-interserver-port [opts] (port opts :clickhouse-interserver-port 9009))
(defn clickhouse-keeper-port [opts] (port opts :clickhouse-keeper-port 9181))
(defn clickhouse-raft-port [opts] (port opts :clickhouse-raft-port 9234))
(defn redis-port [opts] (port opts :redis-port 6379))
(def neon-compute-port 55433)

(defn clickhouse-internal-ports
  "What the three replicas need from each other: the native port for
  distributed queries and `clusterAllReplicas`, interserver for part
  exchange, the Keeper client port, and raft."
  [opts]
  [(clickhouse-native-port opts) (clickhouse-interserver-port opts)
   (clickhouse-keeper-port opts) (clickhouse-raft-port opts)])

(defn app-clickhouse-ports
  "What the app host needs from ClickHouse: HTTP for queries, native for the
  migration runner. Never Keeper, never raft."
  [opts]
  [(clickhouse-http-port opts) (clickhouse-native-port opts)])
