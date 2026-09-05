(ns io.github.getcolors.langfuse.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.langfuse.ssh-config :as ssh-config]
            [io.github.getcolors.langfuse.topology :as topology]
            [io.github.getcolors.langfuse.validate :as validate]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as once-cluster]))

(def infrastructure-tool "langfuse-infrastructure")
(def dns-tool "langfuse-dns")
(def ansible-tool "langfuse-ansible")
(def ansible-local-tool "langfuse-ansible-local")
(def root "io.github.getcolors.langfuse.tools")

;; The storage tier's templates live in the SHA-pinned getcolors/neon
;; dependency, not in this repository. deps.edn there publishes src/resources,
;; so they resolve as namespaced keyword resources off the classpath and are
;; rendered from the dependency — never copied in here, never edited. A copy of
;; a tier this subtle drifts, and the drift is silent.
(def neon-root "io.github.getcolors.neon.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "langfuse"}))
(defn template [path file] (keyword (str root "." path) file))
(defn neon-template [path file] (keyword (str neon-root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(def cidrs
  "A source list as desired state or an overlay string carries it. ONCE's, so
  the validator and the templates can never disagree about what an entry is."
  compute/cidrs)

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

;; ------------------------------------------------------------- compute output

(defn hosts
  "The host list for every stage after compute: the recorded cluster under
  `:once/cluster` on a real run, ONCE's fallbacks on a build (see
  `topology/hosts`)."
  [opts]
  (topology/hosts opts))

;; ---------------------------------------------------------------- compute

;; Cloudflare's published ranges, current as of 2026-09-01. Used when
;; `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
;; unavailable — a `build` on a fresh checkout with no network must still
;; render. A real converge prefers the fetch and never silently widens.
(def cloudflare-ranges-fallback
  ["173.245.48.0/20" "103.21.244.0/22" "103.22.200.0/22" "103.31.4.0/22"
   "141.101.64.0/18" "108.162.192.0/18" "190.93.240.0/20" "188.114.96.0/20"
   "197.234.240.0/22" "198.41.128.0/17" "162.158.0.0/15" "104.16.0.0/13"
   "104.24.0.0/14" "172.64.0.0/13" "131.0.72.0/22"
   "2400:cb00::/32" "2606:4700::/32" "2803:f800::/32" "2405:b500::/32"
   "2405:8100::/32" "2a06:98c0::/29" "2c0f:f248::/32"])

(defn fetch-cloudflare-ranges
  "Cloudflare's published ranges, or nil when they cannot be fetched. Never
  widens on failure: the caller decides."
  []
  (try
    (let [pull (fn [u] (-> (slurp u) str/split-lines (->> (map str/trim) (remove str/blank?))))
          xs (concat (pull "https://www.cloudflare.com/ips-v4")
                     (pull "https://www.cloudflare.com/ips-v6"))]
      (when (seq xs) (vec xs)))
    (catch Exception _ nil)))

(defn http-sources
  "The origin ingress list. `cloudflare` is a symbolic source this package
  RESOLVES; the result carries how it was obtained so the caller can record a
  checksum and a real converge can refuse a stale fallback."
  [opts]
  (let [v (:vultr-http-sources opts)]
    (if-not (= "cloudflare" (str v))
      {:source :explicit :ranges (cidrs opts :vultr-http-sources)}
      (if-let [live (fetch-cloudflare-ranges)]
        {:source :fetched :ranges live}
        {:source :fallback :ranges cloudflare-ranges-fallback}))))

(defn ranges-checksum [xs]
  (let [d (java.security.MessageDigest/getInstance "SHA-256")]
    (->> (str/join "\n" (sort xs)) .getBytes (.digest d)
         (map #(format "%02x" %)) str/join (take 16) str/join)))

(defn infrastructure-data [opts]
  (let [{:keys [source ranges]} (http-sources opts)]
    (assoc opts
           :compute-name (validate/compute-name opts)
           :ssh-keygen (validate/keygen? opts)
           :ssh-sources-hcl (tofu/hcl-list (cidrs opts :vultr-ssh-sources))
           :http-sources-hcl (tofu/hcl-list ranges)
           :http-sources-origin (name source)
           :http-sources-ranges (vec ranges)
           :http-sources-checksum (ranges-checksum ranges)
           :clickhouse-node-count topology/clickhouse-node-count
           ;; Rendered into the firewall: a Selmer key that is absent renders
           ;; as empty rather than failing, and `port = ""` survives build,
           ;; golden and dry-run to be rejected only by the provider.
           :neon-compute-port topology/neon-compute-port
           :redis-port-value (topology/redis-port opts)
           :app-clickhouse-ports-hcl (tofu/hcl-list (map str (topology/app-clickhouse-ports opts)))
           :clickhouse-internal-ports-hcl (tofu/hcl-list (map str (topology/clickhouse-internal-ports opts))))))

(defn resolved-cluster
  "The applied compute stage's `params`, adopted under `:once/cluster` for
  the stages that follow — or ONCE's refusal: no `params` output at all, or
  a machine set that is partial, undeclared, duplicated or incomplete, exits
  1 rather than rendering a ClickHouse cluster config or an app environment
  against the documentation addresses."
  [opts result]
  (once-cluster/resolved-cluster topology/spec opts result {}
                                 (once-cluster/output-params result)))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        data (infrastructure-data opts)
        specs [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)
               ;; The resolved range set is recorded, with a checksum, so a
               ;; firewall change is explainable after the fact.
               (raw-spec (str dir "/http-sources.json")
                         (json/generate-string
                          {:origin (:http-sources-origin data)
                           :checksum (:http-sources-checksum data)
                           :ranges (:http-sources-ranges data)}
                          {:pretty true}))]
        result (tofu/tofu-with-spec opts specs
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) result
      (= :delete (:green/event opts)) result
      :else (resolved-cluster opts result))))

;; ------------------------------------------------------------------- dns

(defn zone-id [] "${data.cloudflare_zone.zone.id}")

(defn dns-json
  "One proxied A record for the public name, pointing at the app host. `ttl 1`
  means automatic: Cloudflare rejects an explicit TTL on a proxied record."
  [opts app-ip]
  (tofu/constructs-json
   [(tofu/construct :resource :cloudflare_dns_record :langfuse
                    {:zone_id (zone-id)
                     :name (:langfuse-host opts)
                     :type "A"
                     :content app-ip
                     :ttl 1
                     :proxied (boolean (:cloudflare-proxied opts))})]))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        app (topology/host-of (hosts opts) :app)
        specs [(spec (template "dns" "main.tf") (str dir "/main.tf") opts)
               (raw-spec (str dir "/record.tf.json") (dns-json opts (:ip app)))]]
    (tofu/tofu-with-spec opts specs {:dir dir :env (credential-env opts :provider-dns)})))

;; ------------------------------------------------------- ssh config (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. Addresses are run-time facts and reach
  the play as extra-vars instead, so the rendered playbook carries no IP and
  is identical on every workstation (SSH Config Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    ;; ansible.cfg and the inventory are the dependency's, unchanged; the play
    ;; is this package's own because it writes six stanzas, not one.
    [(spec (neon-template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (neon-template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ssh-config-hosts
  "The stanzas the managed block carries: the bare profile reaching the app
  host (the spec's entry), then one per machine. ONCE's (Compute Cluster
  Standard §6)."
  [opts hosts*]
  (once-cluster/ssh-config-hosts topology/spec opts hosts*))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ssh_hosts (ssh-config-hosts opts (hosts opts))
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ------------------------------------------------------------------ ansible

(defn inventory
  "Six hosts in four groups, each carrying the facts only it has.

  Every value is a HOST var and no group carries variables: the imported neon
  play targets `neon`, this package's plays target the other three, and
  group_vars precedence would be a live hazard. Cluster-wide facts the plays
  need — the app host's address for the firewall mirrors, the three replica
  addresses for the ClickHouse config — are read through `hostvars` at
  execution time, so one inventory is the single source of every address.

  Sorted maps throughout: an unsorted map of this size stops preserving
  insertion order past an array-map, and every golden would churn."
  [opts hosts*]
  (let [host-entry (fn [h]
                     [(:name h)
                      (into (sorted-map)
                            (cond-> {:ansible_host (:ip h)
                                     :ansible_user (or (:user h) "root")
                                     :vpc_ip (:vpc-ip h)
                                     :role (:role h)}
                              (:index h) (assoc :ordinal (:index h))))])
        group (fn [role]
                {:hosts (into (sorted-map)
                              (map host-entry)
                              (filter #(= (name role) (:role %)) hosts*))})]
    (json/generate-string
     {:all {:children (into (sorted-map)
                            {:neon (group :neon)
                             :redis (group :redis)
                             :clickhouse (group :clickhouse)
                             :app (group :app)})}}
     {:pretty true})))

(defn ansible-data
  "Template values for the Ansible stage.

  Deliberately carries no operator secret. Every credential reaches a host as
  an Ansible `lookup('env', ...)` expression written literally into a play,
  where `preserve-jinja-delimiters` passes it through untouched — routing it
  through this map would let Selmer HTML-escape the quotes and hand Ansible
  `&#39;`."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :compute-name (validate/compute-name opts)
         :neon-compute-port topology/neon-compute-port
         :clickhouse-node-count topology/clickhouse-node-count))

(def neon-files
  ["ansible.cfg" "main.yml" "cleanup.yml" "compose.yml"
   "pageserver.toml" "identity.toml" "config.json" "scramgen.py"
   "bootstrap.sh" "smoke.sh" "status.sh" "rotate.sh"])

(defn neon-specs
  "The storage tier, rendered UNCHANGED from the pinned dependency into its own
  `neon/` subdirectory. The upstream play copies its files by relative `src:`
  name, so rendering them flat beside this package's templates would let a
  same-named file win silently."
  [dir data]
  (let [sub (str dir "/neon")]
    (mapv (fn [f] (spec (neon-template "ansible" f) (str sub "/" f) data)) neon-files)))

(def ansible-files
  "This package's own convergence tree: plays, templates, and the scripts the
  plays install. Rendered flat into the stage beside `neon/`."
  ["site.yml" "common.yml" "neon-pre.yml" "neon-compose.override.yml"
   "clickhouse.yml" "clickhouse-config.xml" "clickhouse-users.xml"
   "clickhouse-backup.xml" "clickhouse-backup.sh" "clickhouse-restore-check.sh"
   "clickhouse-monitor.sh"
   "redis.yml" "redis-compose.yml" "redis-monitor.sh"
   "langfuse.yml" "langfuse-compose.yml" "Caddyfile" "langfuse.env"
   "langfuse-smoke.sh" "langfuse-credential.sh" "langfuse-monitor.sh"
   "langfuse-rehearsal.sh" "langfuse-status.sh"
   "backups.yml" "r2-env.sh" "postgres-backup.sh" "postgres-restore-check.sh"
   "media-backup.sh" "neon-monitor.sh"
   "rehearsal.yml" "cleanup.yml"])

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    (into
     (neon-specs dir data)
     (concat
      ;; The dependency's ansible.cfg, not a local copy: it carries the
      ;; keygen-mode `private_key_file` conditional, and reusing it is the
      ;; only version that stays correct when the standard moves.
      [(spec (neon-template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)]
      (map (fn [f] (spec (template "ansible" f) (str dir "/" f) data)) ansible-files)
      [(raw-spec (str dir "/inventory.json") (inventory data (hosts data)))]))))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (nil? (:once/cluster opts)))
      ;; A readable state without compute: there is no host to stop, and the
      ;; cleanup play would only fail against the placeholder addresses. (An
      ;; unreadable state, or a partial one, never reaches here — the delete
      ;; failed closed at adoption.)
      (assoc opts :green/exit 0)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "site.yml" :delete "cleanup.yml"}
         :host-key-checking false}
        (ansible-specs opts)))))

(defn rehearsal-step
  "The recovery rehearsal: restore both stores from their newest completed
  sets, boot the pinned image against the restored data, read it back through
  the public API, then the node-loss and Redis-restart drills. Only then the
  recovery marker lands. Runs the same rendered tree as the converge."
  [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.json"
       :playbooks {:create "rehearsal.yml"}
       :host-key-checking false}
      (ansible-specs opts))))

;; ------------------------------------------------------------- acceptance

(defn run-quiet
  "Run `args` with `env` overlaid, returning the result map. Nothing from the
  child is echoed; callers decide what becomes an error message, so a secret
  passed through `env` can never leak into output by default."
  [args env timeout-ms]
  (process/run-with-timeout args (if (seq env) {:extra-env env} {}) timeout-ms))

(defn ssh-read
  "A file's content read over SSH through the generated alias, held only in
  this process. Never merged into opts, never printed."
  [alias path]
  (let [r (run-quiet ["ssh" "-o" "BatchMode=yes" alias "cat" path] {} 20000)]
    (when (zero? (:exit r)) (str/trim (str (:out r))))))

(defn curl-args
  "curl with the status code on the last line and a bounded time budget."
  [& args]
  (into ["curl" "-sS" "--max-time" "30" "-w" "\n%{http_code}"] args))

(defn- status-of [{:keys [out]}]
  (last (str/split-lines (str/trim (str out)))))

(defn- body-of [{:keys [out]}]
  (str/join "\n" (butlast (str/split-lines (str out)))))

(defn hex-id
  "An OTel id: `n` random bytes as lowercase hex (16 for a trace, 8 for a span)."
  [n]
  (let [bs (byte-array n)]
    (.nextBytes (java.security.SecureRandom.) bs)
    (apply str (map #(format "%02x" (bit-and % 0xff)) bs))))

(defn otlp-body
  "One OTLP/JSON request: a root span named for the operator path, tagged so
  it can be found, with the observation type and an input/output pair. This
  is the v4 ingestion contract; the legacy batch endpoint rejects every event
  on a fresh v4 deployment."
  [trace-id span-id]
  (let [now (* (System/currentTimeMillis) 1000000)
        attr (fn [k v] {:key k :value {:stringValue v}})]
    (json/generate-string
     {:resourceSpans
      [{:resource {:attributes [(attr "service.name" "colors-operator")]}
        :scopeSpans
        [{:scope {:name "colors-operator"}
          :spans [{:traceId trace-id :spanId span-id :name "colors-operator-acceptance" :kind 1
                   :startTimeUnixNano (str now) :endTimeUnixNano (str (+ now 1000000))
                   :attributes [(attr "langfuse.observation.type" "span")
                                (attr "langfuse.trace.name" "colors-operator-acceptance")
                                {:key "langfuse.trace.tags"
                                 :value {:arrayValue {:values [{:stringValue "colors-operator"}]}}}
                                (attr "langfuse.observation.input" "public-name")
                                (attr "langfuse.observation.output" "ok")]}]}]}]})))

(defn observations-count
  "How many observation rows the v2 API returns for a trace, from a curl
  result, or 0 when the body is not what the API promises."
  [r]
  (try (count (:data (json/parse-string (body-of r) true)))
       (catch Exception _ 0)))

(defn acceptance-step
  "The operator-path gate, after a real create.

  The server-side gates already ran inside the playbook. What is checked from
  here is what only this side can check: the public name over TLS through
  Cloudflare, an ingestion with the generated project keys read over SSH and a
  read-back through the same edge, the refusal of a wrong key, and the SSH
  alias of every machine."
  [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [host (:langfuse-host opts)
          app-alias (ssh-config/host-alias opts)
          pk (ssh-read app-alias "/etc/langfuse/secrets/project_public_key")
          sk (ssh-read app-alias "/etc/langfuse/secrets/project_secret_key")
          base (str "https://" host)
          health (run-quiet (curl-args (str base "/api/public/health?failIfDatabaseUnavailable=true")) {} 40000)]
      (cond
        (not= "200" (status-of health))
        (assoc opts :green/exit 1
               :green/err (str "acceptance: " base "/api/public/health answered "
                               (status-of health) " through the public name"))

        (or (str/blank? (str pk)) (str/blank? (str sk)))
        (assoc opts :green/exit 1
               :green/err "acceptance: could not read the generated project keys over ssh")

        :else
        (let [trace-id (hex-id 16)
              auth (str pk ":" sk)
              ingest (run-quiet (curl-args "-u" auth "-H" "Content-Type: application/json"
                                           "-H" "x-langfuse-ingestion-version: 4"
                                           "-X" "POST" "--data-binary" (otlp-body trace-id (hex-id 8))
                                           (str base "/api/public/otel/v1/traces"))
                                {} 40000)
              v2 (str base "/api/public/v2/observations?traceId=" trace-id "&limit=10")
              deadline (+ (System/currentTimeMillis) 120000)
              read-back (loop []
                          (let [r (run-quiet (curl-args "-u" auth v2) {} 40000)]
                            (cond
                              (and (= "200" (status-of r)) (pos? (observations-count r))) r
                              (< (System/currentTimeMillis) deadline) (do (Thread/sleep 5000) (recur))
                              :else r)))
              denied (run-quiet (curl-args "-u" (str pk ":not-the-key") v2) {} 40000)
              anonymous (run-quiet (curl-args v2) {} 40000)
              aliases (ssh-config/aliases opts)
              unreachable (remove (fn [a] (zero? (:exit (run-quiet ["ssh" "-o" "BatchMode=yes" a "true"] {} 20000))))
                                  aliases)]
          (cond
            (not= "200" (status-of ingest))
            (assoc opts :green/exit 1
                   :green/err (str "acceptance: OTLP ingestion through the public name answered "
                                   (status-of ingest) ": " (str/trim (body-of ingest))))

            (or (not= "200" (status-of read-back)) (zero? (observations-count read-back)))
            (assoc opts :green/exit 1
                   :green/err (str "acceptance: trace " trace-id " was not readable through the public name within 120s (last status "
                                   (status-of read-back) ", " (observations-count read-back) " rows)"))

            (= "200" (status-of denied))
            (assoc opts :green/exit 1
                   :green/err "acceptance: a wrong secret key was accepted through the public name")

            (= "200" (status-of anonymous))
            (assoc opts :green/exit 1
                   :green/err "acceptance: an unauthenticated request was accepted through the public name")

            (seq unreachable)
            (assoc opts :green/exit 1
                   :green/err (str "acceptance: ssh alias unreachable: " (str/join ", " unreachable)))

            :else
            (assoc opts :green/exit 0
                   :langfuse/acceptance {:public-health "200" :ingested trace-id
                                         :read-back "200" :wrong-key "refused"
                                         :anonymous "refused"
                                         :ssh-aliases (count aliases)})))))))

;; --------------------------------------------------------------- describe

(def monitor-files
  {:neon "/var/lib/colors/neon-monitor.json"
   :redis "/var/lib/colors/redis-monitor.json"
   :clickhouse "/var/lib/colors/clickhouse-monitor.json"
   :app "/var/lib/colors/langfuse-monitor.json"})

(defn describe-step
  "Read every host's last monitor result over SSH and print them. Exits
  non-zero when any host is unreachable or reports unhealthy; this is the
  aggregation the README points an external poller at."
  [opts]
  (let [hosts* (hosts opts)
        rows (mapv (fn [h]
                     (let [alias (ssh-config/machine-alias opts h)
                           file (get monitor-files (keyword (:role h)))
                           r (run-quiet ["ssh" "-o" "BatchMode=yes" alias "cat" file] {} 20000)
                           body (str/trim (str (:out r)))
                           parsed (try (json/parse-string body true) (catch Exception _ nil))]
                       {:host (:name h)
                        :reachable (zero? (:exit r))
                        :healthy (boolean (:healthy parsed))
                        :checked (:checked parsed)
                        :problems (or (:problems parsed) (when-not (zero? (:exit r)) ["unreachable or no monitor result yet"]))}))
                   hosts*)]
    (doseq [{:keys [host reachable healthy checked problems]} rows]
      (println (format "%-32s %-10s %s" host
                       (cond (not reachable) "UNKNOWN" healthy "ok" :else "UNHEALTHY")
                       (str (or checked "") (when (seq problems) (str " " (str/join "; " problems)))))))
    (assoc opts :green/exit (if (every? #(and (:reachable %) (:healthy %)) rows) 0 1)
           :langfuse/describe rows)))
