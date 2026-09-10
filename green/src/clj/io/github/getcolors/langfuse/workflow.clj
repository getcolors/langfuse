(ns io.github.getcolors.langfuse.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.langfuse.ssh :as ssh]
            [io.github.getcolors.langfuse.ssh-config :as ssh-config]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.storage :as storage]
            [io.github.getcolors.compute-managed-backend :as managed-backend]
            [io.github.getcolors.langfuse.validate :as validate]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.langfuse.topology :as topology]))

(def defaults {:provider-compute validate/default-compute-provider :provider-dns "cloudflare"
               :provider-backend "r2" :compute-prevent-destroy true
               :workdir ".colors"})

(def state-events #{:delete :rehearse :describe})
(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight opts
     {:defaults defaults :overlay green-cli/read-pars
      :validators [(fn [_ env _] (validate/env-errors env))
                   (fn [opts _ _] (validate/state-errors opts))
                   (fn [opts _ {:keys [event real?]}]
                     (when (and real? (contains? #{:create :delete} event) (empty? (validate/state-errors opts))) (validate/secret-errors opts event)))
                   (fn [opts _ {:keys [event real?]}]
                     (when (and real? (= :delete event) (:compute-prevent-destroy opts)) ["compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false to delete"]))]
      :after-validate (fn [opts _ {:keys [event real?]}]
                        (cond
                          (and real? (contains? state-events event))
                          (let [result (inspection/read-deployment opts (merge (into {} env) (storage/aws-env opts)) {} (topology/requirements opts))]
                            (cond
                              (and (= event :delete) (= "managed" (:s3-bucket-mode opts)) (not= "present" (:status result))) (assoc opts :langfuse/finalize-only true :green/exit 0)
                              (and (= "destroyed" (:status result)) (= event :delete)) (assoc opts :langfuse/already-destroyed true :green/exit 0)
                              (= "present" (:status result)) (let [ready (cond-> (assoc opts :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result) :green/exit 0)
                                                               (get-in result [:key :private_key_path]) (assoc :ssh-private-key-path (get-in result [:key :private_key_path])))]
                                                             (if (and (= event :rehearse) (storage/managed? opts)) (storage/read-credentials! ready) ready))
                              :else (assoc opts :green/exit 1 :green/err "compute state unavailable; legacy monolithic state requires explicit migration")))
                          (and real? (= event :create)) (ssh-config/preflight! opts)
                          :else (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

(defn backend-finalize-step [opts]
  (try
    (let [result (managed-backend/finalize-backend! opts (merge (into {} (System/getenv)) (storage/aws-env opts)))]
      (if (contains? #{"destroyed" "absent" "skipped"} (:status result))
        (assoc opts :green/exit 0)
        (assoc opts :green/exit 1 :green/err "managed backend finalization refused")))
    (catch Exception _ (assoc opts :green/exit 1 :green/err "managed backend finalization refused; live or unowned state remains"))))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    (case step
      :langfuse/start [start-step :langfuse/ansible]
      :langfuse/ansible [tools/ansible-step :langfuse/ssh-config]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its hosts is stale but harmless;
      ;; a key that predeceases them locks the operator out of machines that
      ;; still exist. Both orders are deliberate; see standards/ssh-config.md.
      :langfuse/ssh-config [tools/ansible-local-step :langfuse/dns]
      ;; DNS before the compute destroy: a record pointing at a released
      ;; address is worse than no record.
      :langfuse/dns [tools/dns-step (if (storage/managed? run-opts) :langfuse/storage :langfuse/infrastructure)]
      :langfuse/storage [storage/step :langfuse/infrastructure]
      :langfuse/infrastructure (cond-> [tools/infrastructure-step] (= "managed" (:s3-bucket-mode run-opts)) (conj :langfuse/backend-finalize))
      :langfuse/backend-finalize [backend-finalize-step])

    :rehearse
    (case step
      :langfuse/start [start-step :langfuse/rehearsal]
      :langfuse/rehearsal [tools/rehearsal-step])

    :describe
    (case step
      :langfuse/start [start-step :langfuse/describe]
      :langfuse/describe [tools/describe-step])

    (case step
      :langfuse/start [start-step :langfuse/infrastructure]
      ;; After compute, which is where the addresses first exist, and before
      ;; the stage that converges the machines — the converge and the
      ;; acceptance both ride the aliases this stage writes.
      :langfuse/infrastructure [tools/infrastructure-step (if (storage/managed? run-opts) :langfuse/storage :langfuse/dns)]
      :langfuse/storage [storage/step :langfuse/dns]
      ;; DNS before the converge: Caddy provisions its certificate over ACME
      ;; on first start, and the HTTP-01 challenge needs the name to already
      ;; resolve to the app host.
      :langfuse/dns [tools/dns-step :langfuse/ssh-config]
      :langfuse/ssh-config [tools/ansible-local-step :langfuse/ansible]
      :langfuse/ansible [tools/ansible-step :langfuse/acceptance]
      :langfuse/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:langfuse/backend-finalize :langfuse/storage :langfuse/infrastructure :langfuse/dns :langfuse/ssh-config
   :langfuse/ansible :langfuse/acceptance
   :langfuse/rehearsal :langfuse/describe])

(def workflow
  (-> (wf/workflow {:start :langfuse/start :wire-fn wire-fn
 :next-fn (fn [step successors opts] (cond (or (:langfuse/already-destroyed opts) (wf/failed? opts)) []
                         (and (= step :langfuse/start) (:langfuse/finalize-only opts)) [[:langfuse/backend-finalize opts]]
                         :else (mapv #(vector % opts) successors)))})
      (wf/advice-add :langfuse/dns :before ::backend (backend-advice tools/dns-tool))
      (wf/advice-add :langfuse/storage :before ::storage-backend (backend-advice storage/tool))
      progress/advise
      (dry-run/advise side-effecting)))
