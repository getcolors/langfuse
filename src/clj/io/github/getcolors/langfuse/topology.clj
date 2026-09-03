(ns io.github.getcolors.langfuse.topology
  "Everything that turns desired state into the six machines and their
  addresses.

  Six machines carry far more derived identity than one: a ClickHouse
  replica that names a peer wrongly forms no quorum, an app host that points
  at a stale VPC address fails only after the migration timeout, and a
  firewall rule sourced from the wrong `/32` is a silent denial. Everything
  here is a pure function of desired state plus the compute stage's output,
  so the whole of it is reachable from the test suite and visible in the
  goldens. Nothing in this file may read the environment, the filesystem,
  or the network."
  (:require [clojure.string :as str]))

(def clickhouse-node-count 3)

(def roles
  "The roles in play order. `app` is last because it is the consumer of the
  other three."
  [:neon :redis :clickhouse :app])

(defn compute-name
  "The deployment's base machine name (Compute Name Standard §1-2): the
  profile, unless desired state overrides it with `vultr-name`."
  [opts]
  (let [override (str (:vultr-name opts))]
    (if (or (str/blank? (str/trim override)) (= "REPLACE_ME" (str/trim override)))
      (str (:profile opts))
      (str/trim override))))

(defn machine-name
  "The label of a machine: `<name>-<role>` for the singletons and
  `<name>-clickhouse-<i>` for the replicas."
  ([opts role] (str (compute-name opts) "-" (name role)))
  ([opts role i] (str (compute-name opts) "-" (name role) "-" i)))

(defn clickhouse-indexes [] (vec (range clickhouse-node-count)))

(defn host-ids
  "Every machine this deployment claims, as `{:role :index}` in play order.
  `:index` is nil for the singletons and the replica ordinal for ClickHouse."
  []
  (into [{:role :neon :index nil} {:role :redis :index nil}]
        (concat (map (fn [i] {:role :clickhouse :index i}) (clickhouse-indexes))
                [{:role :app :index nil}])))

(defn host-name [opts {:keys [role index]}]
  (if index (machine-name opts role index) (machine-name opts role)))

(defn plan-key [role] (keyword (str "vultr-plan-" (name role))))

;; ------------------------------------------------------------------ fallback

(defn vpc-block
  "The network address of `vultr-vpc-subnet`, `10.50.0.0/24` -> `10.50.0.0`."
  [opts]
  (first (str/split (str (:vultr-vpc-subnet opts "10.50.0.0/24")) #"/")))

(defn- placeholder-vpc-ip [opts offset]
  (let [octets (str/split (vpc-block opts) #"\.")]
    (str/join "." (conj (vec (take 3 octets)) (str offset)))))

(def ^:private fallback-offsets
  "Where each role's placeholder lands inside the subnet on a credential-free
  build. Documentation ranges (RFC 5737 for the public side), fixed so a
  build is byte-identical on every workstation."
  {:neon 10 :redis 11 :app 12 :clickhouse 20})

(defn fallback-host [opts {:keys [role index] :as id}]
  (let [offset (+ (fallback-offsets role) (or index 0))]
    {:role (name role)
     :index index
     :name (host-name opts id)
     :ip (str "192.0.2." offset)
     :vpc-ip (placeholder-vpc-ip opts offset)
     :user "root"
     :sudoer "root"}))

(defn fallback-hosts [opts] (mapv #(fallback-host opts %) (host-ids)))

;; --------------------------------------------------------------------- hosts

(defn- key-of [{:keys [role index]}] [(name role) (when index (int index))])

(defn hosts
  "The host list the Ansible stage, the DNS stage and the acceptance consume.

  `params` is the compute stage's `hosts` output. On a build there is none, so
  the fallbacks stand in. On a real run a missing or short list is a hard
  error rather than a silent partial cluster (see `missing-host-error`)."
  ([opts] (hosts opts (:langfuse/hosts opts)))
  ([opts params]
   (if (empty? params)
     (fallback-hosts opts)
     (let [by-key (into {} (map (juxt key-of identity)) params)]
       (mapv (fn [id]
               (let [p (get by-key [(name (:role id)) (:index id)])]
                 (merge (fallback-host opts id)
                        (select-keys p [:ip :vpc-ip :user :sudoer]))))
             (host-ids))))))

(defn missing-host-error
  "The error for a compute output that does not cover every machine, or that
  omits an address. Returned rather than thrown so the workflow reports it the
  way it reports every other failure."
  [opts params]
  (when (seq params)
    (let [by-key (into {} (map (juxt key-of identity)) params)
          missing (remove (fn [id]
                            (let [p (get by-key [(name (:role id)) (:index id)])]
                              (and p
                                   (not (str/blank? (str (:ip p))))
                                   (not (str/blank? (str (:vpc-ip p)))))))
                          (host-ids))]
      (when (seq missing)
        (str "the compute stage did not report an address for "
             (str/join ", " (map #(host-name opts %) missing))
             ". Refusing to render a partial deployment: a ClickHouse cluster "
             "config naming fewer replicas than exist forms no quorum, and an "
             "app environment pointing at a missing address fails only after "
             "the migration timeout.")))))

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
