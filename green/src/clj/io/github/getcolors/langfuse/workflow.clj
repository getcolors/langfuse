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
                          (let [result (inspection/read-deployment opts env {} (topology/requirements opts))]
                            (cond
                              (and (= "destroyed" (:status result)) (= event :delete)) (assoc opts :langfuse/already-destroyed true :green/exit 0)
                              (= "present" (:status result)) (cond-> (assoc opts :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result) :green/exit 0)
                                                               (get-in result [:key :private_key_path]) (assoc :ssh-private-key-path (get-in result [:key :private_key_path])))
                              :else (assoc opts :green/exit 1 :green/err "compute state unavailable; legacy monolithic state requires explicit migration")))
                          (and real? (= event :create)) (ssh-config/preflight! opts)
                          :else (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

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
      :langfuse/dns [tools/dns-step :langfuse/infrastructure]
      :langfuse/infrastructure [tools/infrastructure-step])

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
      :langfuse/infrastructure [tools/infrastructure-step :langfuse/dns]
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
  [:langfuse/infrastructure :langfuse/dns :langfuse/ssh-config
   :langfuse/ansible :langfuse/acceptance
   :langfuse/rehearsal :langfuse/describe])

(def workflow
  (-> (wf/workflow {:start :langfuse/start :wire-fn wire-fn
 :next-fn (fn [_ successors opts] (if (or (:langfuse/already-destroyed opts) (wf/failed? opts)) [] (mapv #(vector % opts) successors)))})
      (wf/advice-add :langfuse/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
