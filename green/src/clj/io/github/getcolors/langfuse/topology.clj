(ns io.github.getcolors.langfuse.topology
  "Langfuse roles and connectivity; the compute library owns resources and identity."
  (:require [io.github.getcolors.compute :as library]
            [io.github.getcolors.compute-planning :as planning]
            [io.github.getcolors.compute-deployment-request :as deployment]))
(def default-compute-provider "vultr")
(def clickhouse-node-count 3)
(def roles [:neon :redis :clickhouse :app])
(defn topology [_] (mapv (fn [role] {:role (name role) :count (if (= role :clickhouse) 3 1)}) roles))
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

(defn requirements
  ([opts] (requirements opts (:ranges ((requiring-resolve 'io.github.getcolors.langfuse.tools/http-sources) (assoc opts :green/event :build)))))
  ([opts http-ranges]
   (let [ssh {:id "ssh" :protocol "tcp" :from_port 22 :to_port 22 :sources (deployment/source-cidrs opts "ssh-sources" "langfuse-ssh-sources")}
         peer (fn [id port roles] {:id id :protocol "tcp" :from_port port :to_port port :peer_roles roles})
         policy (fn [rules] {:ingress (into [ssh] rules) :egress "all" :private_filter true})]
     {:private true :entry_node_id "app-0" :legacy_state_keys [(str (:profile opts) "/langfuse-infrastructure.tfstate")]
      :security (policy []) :roles
      {:neon {:security (policy [(peer "postgres" neon-compute-port ["app"])])}
       :redis {:security (policy [(peer "redis" (redis-port opts) ["app"])])}
       :clickhouse {:security (policy (concat (map #(peer (str "app-" %) % ["app"]) (app-clickhouse-ports opts))
                                             (map #(peer (str "replica-" %) % ["clickhouse"]) (clickhouse-internal-ports opts))))}
       :app {:security (policy (map (fn [port] {:id (str "http-" port) :protocol "tcp" :from_port port :to_port port :sources http-ranges}) [80 443]))}}})))
(defn- langfuse-host [node]
  (cond-> (-> node (dissoc :vpc_ip) (assoc :vpc-ip (:vpc_ip node)))
    (not= "clickhouse" (:role node)) (assoc :index nil)))
(defn hosts
  ([opts] (hosts opts (:colors-compute/cluster opts)))
  ([opts params]
   (let [cluster (or params
                     (when (or (= :build (:green/event opts)) (:green/dry-run opts)) (:cluster (planning/plan-deployment opts (topology opts) (requirements opts)))))
         _ (when-not cluster (throw (ex-info "compute cluster unavailable" {})))
         declarations (mapv #(assoc % :private true) (library/expand (topology opts)))]
     (mapv langfuse-host (:nodes (library/collect declarations (:nodes cluster) "app-0"))))))
(defn fallback-hosts [opts] (hosts (assoc opts :green/event :build)))
(defn host-of
  "The single host for `role`, or the `i`th ClickHouse node."
  ([hosts* role] (first (filter #(and (= (name role) (:role %)) (nil? (:index %))) hosts*)))
  ([hosts* role i] (first (filter #(and (= (name role) (:role %)) (= i (:index %))) hosts*))))

(defn clickhouse-hosts [hosts*]
  (->> hosts* (filter #(= "clickhouse" (:role %))) (sort-by :index) vec))
